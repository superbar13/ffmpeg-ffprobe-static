'use strict'

  var os = require('os')
  var path = require('path')

var binaries = Object.assign(Object.create(null), {
  darwin: ['x64', 'arm64'],
  freebsd: ['x64'],
  linux: ['x64', 'ia32', 'arm64', 'arm'],
  win32: ['x64', 'ia32']
})

var platform = process.env.npm_config_platform || os.platform()
var arch = process.env.npm_config_arch || os.arch()

var ffmpegPath = path.join(
  __dirname,
  'bin',
  platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
)

var ffprobePath = path.join(
  __dirname,
  'bin',
  platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'
)

if (!binaries[platform] || binaries[platform].indexOf(arch) === -1) {
  ffmpegPath = null
}

if (!binaries[platform] || binaries[platform].indexOf(arch) === -1) {
  ffprobePath = null
}

module.exports = {
  ffmpegPath: ffmpegPath,
  ffprobePath: ffprobePath
}