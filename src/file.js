var utils = require('./utils')
var Uchunk = require('./chunk')

function Ufile (uploader, file, parent) {
	this.uploader = uploader
	this.isRoot = this.isFolder = uploader === this
	this.parent = parent || null
	this.files = []
	this.fileList = []
	this.chunks = []
	this.bytes = null

	if (this.isRoot || !file) {
		this.file = null
	} else {
		if (utils.isString(file)) {
			// folder
			this.isFolder = true
			this.path = file
			if (this.parent.path) {
				file = file.substr(this.parent.path.length)
			}
			this.name = file.charAt(file.length - 1) === '/' ? file.substr(0, file.length - 1) : file
		} else {
			this.file = file
			this.name = file.fileName || file.name
			this.size = file.size
			this.relativePath = file.relativePath || file.webkitRelativePath || this.name
			this.uniqueIdentifier = uploader.generateUniqueIdentifier(file)
			this._parseFile()
		}
	}

	this.started = false
	this.paused = false
	this.error = false
	this.averageSpeed = 0
	this.currentSpeed = 0
	this._lastProgressCallback = Date.now()
	this._prevUploadedSize = 0
	this._prevProgress = 0

	this.bootstrap()
}

utils.extend(Ufile.prototype, {

	_parseFile: function () {
		var ppaths = parsePaths(this.relativePath)
		if (ppaths.length) {
			var filePaths = this.uploader.filePaths
			utils.each(ppaths, function (path, i) {
				var folderFile = filePaths[path]
				if (!folderFile) {
					folderFile = new Ufile(this.uploader, path, this.parent)
					filePaths[path] = folderFile
					this._updateParentFileList(folderFile)
				}
				this.parent = folderFile
				if (!ppaths[i + 1]) {
					folderFile.files.push(this)
					folderFile.fileList.push(this)
				}
			}, this)
		} else {
			this._updateParentFileList()
		}
	},

	_updateParentFileList: function (ufile) {
		if (!ufile) {
			ufile = this
		}
		var p = this.parent
		if (p) {
			p.fileList.push(ufile)
			while (p && !p.isRoot) {
				p.files.push(this)
				p = p.parent
			}
		}
	},

	_eachAccess: function (eachFn, fileFn) {
		if (this.isFolder) {
			utils.each(this.files, function (f, i) {
				return eachFn.call(this, f, i)
			}, this)
			return
		}
		if (!fileFn) {
			fileFn = eachFn
		}
		fileFn.call(this, this)
	},

	bootstrap: function () {
		if (this.isFolder) return
		var opts = this.uploader.opts
		if (utils.isFunction(opts.initFileFn)) {
			opts.initFileFn.call(this, this)
		}

		this.abort(true)
		this.error = false
		// Rebuild stack of chunks from file
		this._prevProgress = 0
		var round = opts.forceChunkSize ? Math.ceil : Math.floor
		var chunks = Math.max(round(this.size / opts.chunkSize), 1)
		for (var offset = 0; offset < chunks; offset++) {
			this.chunks.push(new Uchunk(this.uploader, this, offset))
		}
	},

	_measureSpeed: function () {
		var timeSpan = Date.now() - this._lastProgressCallback
		if (!timeSpan) {
			return
		}
		var smoothingFactor = this.uploader.opts.speedSmoothingFactor
		var uploaded = this.sizeUploaded()
		// Prevent negative upload speed after file upload resume
		this.currentSpeed = Math.max((uploaded - this._prevUploadedSize) / timeSpan * 1000, 0)
		this.averageSpeed = smoothingFactor * this.currentSpeed + (1 - smoothingFactor) * this.averageSpeed
		this._prevUploadedSize = uploaded
	},

	_chunkEvent: function (chunk, evt, message) {
		var uploader = this.uploader
		var STATUS = Uchunk.STATUS
		switch (evt) {
			case STATUS.PROGRESS:
				if (Date.now() - this._lastProgressCallback < uploader.opts.progressCallbacksInterval) {
					break
				}
				this._measureSpeed()
				uploader._trigger('fileProgress', this, chunk)
				uploader._trigger('progress')
				this._lastProgressCallback = Date.now()
				break
			case STATUS.ERROR:
				this.error = true
				this.abort(true)
				uploader._trigger('fileError', this, message, chunk)
				uploader._trigger('error', message, this, chunk)
				break
			case STATUS.SUCCESS:
				if (this.error) {
					return
				}
				this._measureSpeed()
				uploader._trigger('fileProgress', this, chunk)
				uploader._trigger('progress')
				this._lastProgressCallback = Date.now()
				if (this.isComplete()) {
					this.currentSpeed = 0
					this.averageSpeed = 0
					uploader._trigger('fileSuccess', this, message, chunk)
				}
				break
			case STATUS.RETRY:
				uploader._trigger('fileRetry', this, chunk)
				break
		}
	},

	isComplete: function () {
		var outstanding = false
		this._eachAccess(function (file) {
			if (!file.isComplete()) {
				outstanding = true
				return false
			}
		}, function () {
			var STATUS = Uchunk.STATUS
			utils.each(this.chunks, function (chunk) {
				var status = chunk.status()
				if (status === STATUS.PENDING || status === STATUS.UPLOADING || status === STATUS.READING || chunk.preprocessState === 1 || chunk.readState === 1) {
					outstanding = true
					return false
				}
			})
		})
		return !outstanding
	},

	isUploading: function () {
		var uploading = false
		this._eachAccess(function (file) {
			if (file.isUploading()) {
				uploading = true
				return false
			}
		}, function () {
			var uploadingStatus = Uchunk.STATUS.UPLOADING
			utils.each(this.chunks, function (chunk) {
				if (chunk.status() === uploadingStatus) {
					uploading = true
					return false
				}
			})
		})
		return uploading
	},

	resume: function () {
		this._eachAccess(function (f) {
			f.resume()
		}, function () {
			this.paused = false
			this.uploader.upload()
		})
	},

	pause: function () {
		this._eachAccess(function (f) {
			f.pause()
		}, function () {
			this.paused = true
			this.abort()
		})
	},

	cancel: function () {
		if (this.isFolder) {
			for (var i = this.files.length - 1; i >= 0; i--) {
				this.files[i].cancel()
			}
			return
		}
		this.uploader.removeFile(this)
	},

	retry: function (file) {
		if (file) {
			file.bootstrap()
		} else {
			this._eachAccess(function (f) {
				f.bootstrap()
			}, function () {
				this.file.bootstrap()
			})
		}
		this.uploader.upload()
	},

	abort: function (reset) {
		this.currentSpeed = 0
		this.averageSpeed = 0
		var chunks = this.chunks
		if (reset) {
			this.chunks = []
		}
		var uploadingStatus = Uchunk.STATUS.UPLOADING
		utils.each(chunks, function (c) {
			if (c.status() === uploadingStatus) {
				c.abort()
				this.uploader.uploadNextChunk()
			}
		}, this)
	},

	progress: function () {
		var totalDone = 0
		var totalSize = 0
		var ret
		this._eachAccess(function (file, index) {
			totalDone += file.progress() * file.size
			totalSize += file.size
			if (index === this.files.length - 1) {
				ret = totalSize > 0 ? totalDone / totalSize
						: this.isComplete() ? 1 : 0
			}
		}, function () {
			if (this.error) {
				ret = 1
				return
			}
			if (this.chunks.length === 1) {
				this._prevProgress = Math.max(this._prevProgress, this.chunks[0].progress())
				ret = this._prevProgress
				return
			}
			// Sum up progress across everything
			var bytesLoaded = 0
			utils.each(this.chunks, function (c) {
				// get chunk progress relative to entire file
				bytesLoaded += c.progress() * (c.endByte - c.startByte)
			})
			var percent = bytesLoaded / this.size
			// We don't want to lose percentages when an upload is paused
			this._prevProgress = Math.max(this._prevProgress, percent > 0.9999 ? 1 : percent)
			ret = this._prevProgress
		})
		return ret
	},

	getSize: function () {
		var size = 0
		this._eachAccess(function (file) {
			size += file.size
		}, function () {
			size += this.size
		})
		return size
	},

	sizeUploaded: function () {
		var size = 0
		this._eachAccess(function (file) {
			size += file.sizeUploaded()
		}, function () {
			utils.each(this.chunks, function (chunk) {
				size += chunk.sizeUploaded()
			})
		})
		return size
	},

	timeRemaining: function () {
		var ret
		var sizeDelta = 0
		var averageSpeed = 0
		this._eachAccess(function (file, i) {
			if (!file.paused && !file.error) {
				sizeDelta += file.size - file.sizeUploaded()
				averageSpeed += file.averageSpeed
			}
			if (i === this.files.length - 1) {
				ret = calRet(sizeDelta, averageSpeed)
			}
		}, function () {
			if (this.paused || this.error) {
				ret = 0
				return
			}
			var delta = this.size - this.sizeUploaded()
			ret = calRet(delta, this.averageSpeed)
		})
		return ret
		function calRet (delta, averageSpeed) {
			if (delta && !averageSpeed) {
				return Number.POSITIVE_INFINITY
			}
			if (!delta && !averageSpeed) {
				return 0
			}
			return Math.floor(delta / averageSpeed)
		}
	},

	removeFile: function (file) {
		if (file.isFolder) {
			if (file.parent) {
				file.parent._removeFile(file)
			}
			utils.each(file.files, function (f) {
				this.removeFile(f)
			}, this)
			return
		}
		utils.each(this.files, function (f, i) {
			if (f === file) {
				this.files.splice(i, 1)
				file.abort()
				if (file.parent) {
					file.parent._removeFile(file)
				}
				return false
			}
		}, this)
	},

	_removeFile: function (file) {
		!file.isFolder && utils.each(this.files, function (f, i) {
			if (f === file) {
				this.files.splice(i, 1)
				if (this.parent) {
					this.parent._removeFile(file)
				}
				return false
			}
		}, this)
		file.parent === this && utils.each(this.fileList, function (f, i) {
			if (f === file) {
				this.fileList.splice(i, 1)
				return false
			}
		}, this)
	},

	getType: function () {
		if (this.isFolder) {
			return 'Folder'
		}
		return this.file.type && this.file.type.split('/')[1]
	},

	getExtension: function () {
		if (this.isFolder) {
			return ''
		}
		return this.name.substr((~-this.name.lastIndexOf('.') >>> 0) + 2).toLowerCase()
	}

})

module.exports = Ufile

function parsePaths (path) {
	var ret = []
	var paths = path.split('/')
	var len = paths.length
	var i = 1
	paths.splice(len - 1, 1)
	len--
	if (paths.length) {
		while (i <= len) {
			ret.push(paths.slice(0, i++).join('/') + '/')
		}
	}
	return ret
}
