// Argument, credential-file and output-path handling for workspace-config.cjs.
// Nothing here touches a browser or a network. Errors never include credential values.

const fs = require('fs')
const path = require('path')

const MAX_CREDENTIAL_BYTES = 64 * 1024

const COMMAND_OPTIONS = {
  list: [],
  set: ['disable', 'enable'],
  verify: ['landing-path', 'require', 'forbid', 'open', 'widget', 'screenshot', 'expect-role'],
  phase0: ['expect-role', 'screenshot', 'require-document-page', 'document-screenshot']
}
const FLAG_OPTIONS = new Set(['require-document-page'])

function parseArgs (argv) {
  const [command, ...rest] = argv
  const allowed = COMMAND_OPTIONS[command]
  if (allowed === undefined) throw new Error(`unknown command: ${command ?? '(none)'}`)
  const options = {}
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]
    if (!arg.startsWith('--')) throw new Error(`unexpected argument: ${arg}`)
    const name = arg.slice(2)
    if (!allowed.includes(name)) throw new Error(`unknown option for ${command}: --${name}`)
    if (name in options) throw new Error(`option given twice: --${name}`)
    if (FLAG_OPTIONS.has(name)) {
      options[name] = true
      continue
    }
    const value = rest[++i]
    if (value === undefined || value.startsWith('--')) throw new Error(`option needs a value: --${name}`)
    options[name] = value
  }
  validateCommand(command, options)
  return { command, options }
}

function validateCommand (command, options) {
  const needs = (name) => {
    if (options[name] === undefined) throw new Error(`${command} needs --${name}`)
  }
  if (command === 'verify') {
    needs('landing-path')
    // An empty list would make the rail check pass without checking anything.
    for (const name of ['require', 'forbid']) {
      needs(name)
      if (csv(options[name]).length === 0) throw new Error(`--${name} must name at least one app`)
    }
  }
  if (command === 'phase0') {
    needs('expect-role')
    needs('screenshot')
    if (options['document-screenshot'] !== undefined && options['require-document-page'] !== true) {
      throw new Error('--document-screenshot needs --require-document-page')
    }
  }
  if (command === 'set') {
    const disable = csv(options.disable)
    const enable = csv(options.enable)
    if (disable.length + enable.length === 0) throw new Error('set needs --disable or --enable with at least one plugin')
    const overlap = disable.filter((name) => enable.includes(name))
    if (overlap.length > 0) throw new Error(`plugin in both --disable and --enable: ${overlap.join(', ')}`)
  }
}

function csv (value) {
  return (value ?? '').split(',').map((s) => s.trim()).filter(Boolean)
}

function validateBaseUrl (value) {
  if (value === undefined || value === '') throw new Error('HULY_URL is not set')
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error('HULY_URL is not a valid URL')
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('HULY_URL must use http or https')
  if (url.pathname !== '/' || url.search !== '' || url.username !== '' || url.password !== '') {
    throw new Error('HULY_URL must be an origin with no path, query or credentials')
  }
  return url.origin
}

function validateWorkspace (value) {
  if (value === undefined || value === '') throw new Error('target workspace is empty: set HULY_WORKSPACE or SMOKE_WS_URL')
  if (!/^[a-z0-9][a-z0-9-]*$/.test(value)) throw new Error('target workspace is not a valid workspace URL slug')
  return value
}

// Decode one value in the formats bash `printf %q` writes: backslash escapes, 'single
// quotes' and $'ANSI-C quotes'. Anything else is rejected rather than guessed at.
function decodeShellWord (word) {
  const bytes = []
  const pushText = (text) => bytes.push(...Buffer.from(text, 'utf8'))
  const unsupported = () => new Error('unsupported shell quoting')
  let i = 0
  while (i < word.length) {
    const ch = word[i]
    if (ch === '\\') {
      if (i + 1 >= word.length) throw unsupported()
      const cp = String.fromCodePoint(word.codePointAt(i + 1))
      pushText(cp)
      i += 1 + cp.length
    } else if (ch === '$' && word[i + 1] === "'") {
      i = decodeAnsiC(word, i + 2, bytes, unsupported)
    } else if (ch === "'") {
      const end = word.indexOf("'", i + 1)
      if (end === -1) throw unsupported()
      pushText(word.slice(i + 1, end))
      i = end + 1
    } else if (/[\s"`$&;|<>()]/.test(ch)) {
      throw unsupported()
    } else {
      const cp = String.fromCodePoint(word.codePointAt(i))
      pushText(cp)
      i += cp.length
    }
  }
  const buffer = Buffer.from(bytes)
  const text = buffer.toString('utf8')
  if (!Buffer.from(text, 'utf8').equals(buffer)) throw unsupported()
  return text
}

const ANSI_C_ESCAPES = { a: 7, b: 8, e: 27, E: 27, f: 12, n: 10, r: 13, t: 9, v: 11, '\\': 92, "'": 39, '"': 34, '?': 63 }

function decodeAnsiC (word, start, bytes, unsupported) {
  let i = start
  while (i < word.length) {
    const ch = word[i]
    if (ch === "'") return i + 1
    if (ch !== '\\') {
      const cp = String.fromCodePoint(word.codePointAt(i))
      bytes.push(...Buffer.from(cp, 'utf8'))
      i += cp.length
      continue
    }
    const next = word[i + 1]
    if (next === undefined) throw unsupported()
    if (next in ANSI_C_ESCAPES) {
      bytes.push(ANSI_C_ESCAPES[next])
      i += 2
      continue
    }
    const octal = word.slice(i + 1).match(/^[0-7]{1,3}/)
    if (octal != null) {
      const value = parseInt(octal[0], 8)
      if (value > 255) throw unsupported()
      bytes.push(value)
      i += 1 + octal[0].length
      continue
    }
    const hex = word.slice(i + 1).match(/^x([0-9a-fA-F]{1,2})/)
    if (hex != null) {
      bytes.push(parseInt(hex[1], 16))
      i += 1 + hex[0].length
      continue
    }
    const unicode = word.slice(i + 1).match(/^(?:u([0-9a-fA-F]{1,4})|U([0-9a-fA-F]{1,8}))/)
    if (unicode != null) {
      const code = parseInt(unicode[1] ?? unicode[2], 16)
      if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) throw unsupported()
      bytes.push(...Buffer.from(String.fromCodePoint(code), 'utf8'))
      i += 1 + unicode[0].length
      continue
    }
    throw unsupported()
  }
  throw unsupported()
}

function parseStateText (text) {
  const state = {}
  for (const [index, line] of text.split('\n').entries()) {
    if (line.trim() === '' || line.startsWith('#')) continue
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/s)
    if (match == null) throw new Error(`credential file line ${index + 1} is not KEY=value`)
    try {
      state[match[1]] = decodeShellWord(match[2])
    } catch (error) {
      throw new Error(`credential file: ${match[1]} has ${error.message}; use plain text or bash printf %q`)
    }
  }
  for (const key of ['SMOKE_EMAIL', 'SMOKE_PASSWORD']) {
    if (state[key] === undefined || state[key] === '') throw new Error(`credential file has no ${key}`)
  }
  return state
}

function currentUid (options) {
  const uid = options?.uid ?? process.getuid?.()
  if (uid === undefined) throw new Error('credential file checks need a POSIX system')
  return uid
}

// No user other than this one or root can swap a path component that sits under a
// directory they cannot write to. Sticky directories such as /tmp are safe the same way.
function checkAncestors (directory, uid) {
  let current = fs.realpathSync(directory)
  for (;;) {
    const stat = fs.statSync(current)
    if (stat.uid !== uid && stat.uid !== 0) throw new Error('credential file: a parent directory is owned by another user')
    if ((stat.mode & 0o022) !== 0 && (stat.mode & 0o1000) === 0) {
      throw new Error('credential file: a parent directory is writable by others')
    }
    const parent = path.dirname(current)
    if (parent === current) return
    current = parent
  }
}

function checkCredentialStat (stat, uid) {
  if (!stat.isFile()) throw new Error('credential file is not a regular file')
  if (stat.uid !== uid) throw new Error('credential file is owned by another user')
  if ((stat.mode & 0o077) !== 0) throw new Error('credential file permissions are too open: use chmod 600')
  if (stat.nlink !== 1) throw new Error('credential file has more than one hard link')
  if (stat.size > MAX_CREDENTIAL_BYTES) throw new Error('credential file is too large')
}

// Returns the parsed state plus the file's identity, so output paths can be checked against it.
function readCredentialFile (file, options) {
  const uid = currentUid(options)
  const stat = fs.lstatSync(file)
  if (stat.isSymbolicLink()) throw new Error('credential file is a symbolic link')
  checkCredentialStat(stat, uid)
  checkAncestors(path.dirname(path.resolve(file)), uid)
  // O_NOFOLLOW and the second stat close the gap between the checks and the read.
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
  try {
    const opened = fs.fstatSync(fd)
    checkCredentialStat(opened, uid)
    if (opened.ino !== stat.ino || opened.dev !== stat.dev) throw new Error('credential file changed while reading')
    return {
      state: parseStateText(fs.readFileSync(fd, 'utf8')),
      identity: { dev: opened.dev, ino: opened.ino }
    }
  } finally {
    fs.closeSync(fd)
  }
}

function sameFile (stat, identity) {
  return stat.dev === identity.dev && stat.ino === identity.ino
}

function checkOutputStat (stat, identity) {
  if (!stat.isFile()) throw new Error('screenshot path exists and is not a regular file')
  if (sameFile(stat, identity)) throw new Error('screenshot path is the credential file')
  if (stat.nlink !== 1) throw new Error('screenshot path has more than one hard link')
}

// Check before logging in, so a bad path fails without touching the deployment.
function resolveOutputPath (file, identity) {
  if (path.extname(file) !== '.png') throw new Error('screenshot path must end in .png')
  // Resolving the parent means a parent symlink leading to the credential file reaches the
  // inode comparison in checkOutputStat, like any other alias.
  const resolved = path.join(fs.realpathSync(path.dirname(path.resolve(file))), path.basename(file))
  let stat
  try {
    stat = fs.lstatSync(resolved)
  } catch (error) {
    if (error.code === 'ENOENT') return resolved
    throw error
  }
  if (stat.isSymbolicLink()) throw new Error('screenshot path is a symbolic link')
  checkOutputStat(stat, identity)
  return resolved
}

// Playwright's own path option would follow a link planted after the check, so write here.
function writeOutputFile (resolved, data, identity) {
  const fd = fs.openSync(resolved, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600)
  try {
    checkOutputStat(fs.fstatSync(fd), identity)
    fs.ftruncateSync(fd, 0)
    fs.writeSync(fd, data)
  } finally {
    fs.closeSync(fd)
  }
}

module.exports = {
  csv,
  decodeShellWord,
  parseArgs,
  parseStateText,
  readCredentialFile,
  resolveOutputPath,
  validateBaseUrl,
  validateWorkspace,
  writeOutputFile
}
