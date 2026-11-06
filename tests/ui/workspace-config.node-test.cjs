// Regression tests for workspace-config.cjs. They run the real command line in a real browser
// against a local synthetic server (fixtures/fake-huly.cjs) and never touch a deployment.
//
// Run: npm run test:config

const assert = require('node:assert/strict')
const { execFile, execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { after, before, describe, test } = require('node:test')
const contract = require('./phase0-contract.json')
const { startFakeHuly } = require('./fixtures/fake-huly.cjs')
const {
  decodeShellWord,
  parseArgs,
  parseStateText,
  readCredentialFile,
  resolveOutputPath,
  writeOutputFile
} = require('./workspace-config-lib.cjs')

const EMAIL = 'synthetic-user@example.com'
const PASSWORD = 'synthetic-Pass-1234'
const TOOL = path.join(__dirname, 'workspace-config.cjs')

let dir
let stateFile

before(() => {
  // realpath: on macOS the temp directory is reached through a symlink
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-config-test-')))
  stateFile = writeState('state')
})
after(() => fs.rmSync(dir, { recursive: true, force: true }))

function writeState (name, text = `SMOKE_EMAIL=${EMAIL}\nSMOKE_PASSWORD=${PASSWORD}\nSMOKE_WS_URL=team\n`, mode = 0o600) {
  const file = path.join(dir, name)
  fs.writeFileSync(file, text, { mode })
  fs.chmodSync(file, mode)
  return file
}

function run (args, env = {}) {
  return new Promise((resolve) => {
    const childEnv = {
      ...process.env,
      HULY_STATE_FILE: stateFile,
      HULY_TIMEOUT_MS: '2000',
      ...env
    }
    delete childEnv.HULY_WORKSPACE
    if (env.HULY_WORKSPACE !== undefined) childEnv.HULY_WORKSPACE = env.HULY_WORKSPACE
    execFile(process.execPath, [TOOL, ...args], { env: childEnv }, (error, stdout, stderr) => {
      resolve({ code: error == null ? 0 : error.code, stdout, stderr, output: stdout + stderr })
    })
  })
}

function assertNoCredentials (result) {
  assert.ok(!result.output.includes(PASSWORD), 'password in output')
  assert.ok(!result.output.includes(EMAIL), 'email in output')
}

async function withFake (options, body) {
  const fake = await startFakeHuly(options)
  try {
    return await body(fake)
  } finally {
    await fake.stop()
  }
}

const screenshotPath = (name) => path.join(dir, `${name}.png`)

async function phase0 (options, extra = []) {
  return await withFake(options, (fake) =>
    run(['phase0', '--expect-role', options.role ?? 'OWNER', '--screenshot', screenshotPath('phase0'), ...extra], { HULY_URL: fake.url })
  )
}

describe('phase0 acceptance', () => {
  test('passes on a deployment that meets the contract', async () => {
    const result = await phase0({})
    assert.equal(result.code, 0, result.output)
    assert.match(result.stdout, /PASS: phase0/)
    assert.ok(fs.statSync(screenshotPath('phase0')).size > 0)
    assertNoCredentials(result)
  })

  test('passes for a USER, and says plugin state was not checked', async () => {
    const result = await phase0({ role: 'USER' })
    assert.equal(result.code, 0, result.output)
    assert.match(result.stdout, /plugin state: not checked/)
  })

  test('opens a real document when required', async () => {
    const result = await phase0({}, ['--require-document-page', '--document-screenshot', screenshotPath('document')])
    assert.equal(result.code, 0, result.output)
    assert.ok(fs.statSync(screenshotPath('document')).size > 0)
  })

  const rejected = [
    ['tracker fallback under the right app', { landing: 'document/tracker:project:DefaultProject/issues' }, /FAIL: landing route is/],
    ['landing on tracker', { landing: 'tracker/tracker:project:DefaultProject/issues' }, /FAIL: landing route is/],
    ['uncaught page crash', { crash: true }, /runtime errors/],
    ['HTTP 500 during use', { serverError: true }, /runtime errors: HTTP 500/],
    ['landing page with no table rows', { rows: 0 }, /FAIL: landing page has 0 table rows/],
    ['landing page that renders nothing', { blankPage: true }, /FAIL: landing page does not show/],
    ['empty navigator', { emptyNavigator: true }, /FAIL: landing navigator/],
    ['forbidden app in the rail', { rail: ['hr:string:HR', 'document:string:D', 'card:string:C', 'tracker:string:T', 'chunter:string:C', 'contact:string:C', 'calendar:string:C'] }, /forbidden app in rail: hr/],
    ['app outside the contract in the rail', { rail: ['surprise:string:S', 'document:string:D', 'card:string:C', 'tracker:string:T', 'chunter:string:C', 'contact:string:C', 'calendar:string:C'] }, /app not in the contract: surprise/],
    ['required app missing', { rail: ['document:string:D', 'card:string:C', 'tracker:string:T', 'contact:string:C', 'calendar:string:C'] }, /required app missing from rail: chunter/],
    ['app that routes elsewhere', { wrongRoute: { card: 'tracker' } }, /opening card routed/],
    ['app showing another navigator', { titles: { card: 'Wrong' } }, /card navigator title/],
    ['"Today" on the page while the calendar never opens', { todayInPage: true, calendar: 'none' }, /calendar widget did not open/],
    ['calendar widget with no time grid', { calendar: 'no-grid' }, /no time grid/],
    ['role other than expected', { role: 'USER', expectRole: 'OWNER' }, /role is USER/],
    ['plugin left on', { plugins: { Office: true } }, /plugin Office is on/],
    ['kept plugin turned off', { plugins: { Tracker: false } }, /plugin Tracker is off/],
    ['plugin outside the contract', { plugins: { Surprise: false } }, /plugin not in the contract: Surprise/],
    ['workspace other than the target', { selectedWorkspace: 'other' }, /not the target/]
  ]
  for (const [name, options, message] of rejected) {
    test(`fails on ${name}`, async () => {
      const result = await withFake(options, (fake) =>
        run(['phase0', '--expect-role', options.expectRole ?? options.role ?? 'OWNER', '--screenshot', screenshotPath('rejected')], { HULY_URL: fake.url })
      )
      assert.notEqual(result.code, 0, result.output)
      // match the FAIL line itself: progress lines on stdout mention the same words
      assert.match(result.stderr, message)
    })
  }

  test('fails when a required document page is missing or empty', async () => {
    for (const options of [{ documents: 0 }, { blankDocument: true }]) {
      const result = await phase0(options, ['--require-document-page'])
      assert.notEqual(result.code, 0, result.output)
      assert.match(result.stderr, /FAIL: (no document in the navigator|opened document shows no content)/)
    }
  })
})

describe('set', () => {
  const setOff = (fake, extra = {}) =>
    run(['set', '--disable', 'Tracker'], { HULY_URL: fake.url, ...extra })

  test('changes the plugin and reports it from a new session', async () => {
    await withFake({}, async (fake) => {
      const result = await setOff(fake)
      assert.equal(result.code, 0, result.output)
      assert.equal(fake.plugins().Tracker, false)
      assert.equal(fake.logins, 2)
    })
  })

  test('fails when the change does not persist', async () => {
    await withFake({ persist: false }, async (fake) => {
      const result = await setOff(fake)
      assert.notEqual(result.code, 0, result.output)
      assert.match(result.output, /"Tracker" did not persist/)
      assert.doesNotMatch(result.stdout, /changed: Tracker/)
    })
  })

  test('fails when the change is gone in a new session', async () => {
    await withFake({ revertOnLogin: true }, async (fake) => {
      const result = await setOff(fake)
      assert.notEqual(result.code, 0, result.output)
      assert.match(result.output, /not enabled=false in a new session/)
    })
  })

  const refusesBeforeToggling = [
    ['a different selected workspace', { selectedWorkspace: 'other' }, ['set', '--disable', 'Tracker'], /not the target/],
    ['a non-owner', { role: 'USER' }, ['set', '--disable', 'Tracker'], /role is USER/],
    ['an unknown plugin, even alongside a known one', {}, ['set', '--disable', 'Tracker,Trackr'], /unknown plugin: Trackr/]
  ]
  for (const [name, options, args, message] of refusesBeforeToggling) {
    test(`refuses ${name} without toggling anything`, async () => {
      await withFake(options, async (fake) => {
        const result = await run(args, { HULY_URL: fake.url })
        assert.notEqual(result.code, 0, result.output)
        assert.match(result.output, message)
        assert.deepEqual(fake.toggles, [])
      })
    })
  }
})

describe('generic verify', () => {
  const good = ['verify', '--landing-path', contract.landingPath, '--require', 'document', '--forbid', 'hr']

  test('passes, and says it is not Phase 0 acceptance', async () => {
    const result = await withFake({}, (fake) => run(good, { HULY_URL: fake.url }))
    assert.equal(result.code, 0, result.output)
    assert.match(result.stdout, /not Phase 0 acceptance/)
  })

  test('fails on the wrong full route even when the app matches', async () => {
    const result = await withFake({ landing: 'document/tracker:project:DefaultProject/issues' }, (fake) => run(good, { HULY_URL: fake.url }))
    assert.notEqual(result.code, 0, result.output)
    assert.match(result.stderr, /FAIL: landing route is/)
  })

  test('fails on a runtime error', async () => {
    const result = await withFake({ crash: true }, (fake) => run(good, { HULY_URL: fake.url }))
    assert.notEqual(result.code, 0, result.output)
    assert.match(result.stderr, /FAIL: runtime errors/)
  })
})

describe('command line, without contacting the deployment', () => {
  const rejected = [
    [['verify', '--landing-path', 'a/b/c'], /needs --require/],
    [['verify', '--landing-path', 'a/b/c', '--require', ',', '--forbid', 'x'], /--require must name/],
    [['verify', '--landing-path', 'a/b/c', '--require', 'x', '--forbid', ' '], /--forbid must name/],
    [['verify', '--require', 'x', '--forbid', 'y'], /needs --landing-path/],
    [['verify', '--landing', 'document', '--require', 'x', '--forbid', 'y'], /unknown option for verify: --landing/],
    [['phase0', '--screenshot', 'a.png'], /needs --expect-role/],
    [['phase0', '--expect-role', 'OWNER'], /needs --screenshot/],
    [['phase0', '--expect-role', 'OWNER', '--screenshot', 'a.png', '--typo', 'x'], /unknown option/],
    [['set'], /set needs/],
    [['set', '--disable', ' , '], /set needs/],
    [['set', '--disable', 'A', '--enable', 'A'], /in both/],
    [['set', '--disable', 'A', '--disable', 'B'], /given twice/],
    [['set', '--disable'], /needs a value/],
    [['list', 'extra'], /unexpected argument/],
    [['frobnicate'], /unknown command/],
    [[], /unknown command/]
  ]
  for (const [args, message] of rejected) {
    test(`rejects: ${args.join(' ') || '(no arguments)'}`, async () => {
      await withFake({}, async (fake) => {
        const result = await run(args, { HULY_URL: fake.url })
        assert.notEqual(result.code, 0)
        assert.match(result.output, message)
        assert.equal(fake.requests, 0)
      })
    })
  }

  test('rejects an empty or malformed target workspace', async () => {
    await withFake({}, async (fake) => {
      for (const workspace of ['', '../other', 'UPPER', 'a/b']) {
        const result = await run(['list'], { HULY_URL: fake.url, HULY_WORKSPACE: workspace })
        assert.notEqual(result.code, 0, `accepted "${workspace}"`)
        assert.match(result.output, /target workspace/)
      }
      assert.equal(fake.requests, 0)
    })
  })

  test('rejects a state file with no target workspace', async () => {
    const file = writeState('no-workspace', `SMOKE_EMAIL=${EMAIL}\nSMOKE_PASSWORD=${PASSWORD}\n`)
    const result = await run(['list'], { HULY_URL: 'http://127.0.0.1:9', HULY_STATE_FILE: file })
    assert.notEqual(result.code, 0)
    assert.match(result.output, /target workspace is empty/)
  })

  test('rejects a bad HULY_URL', async () => {
    for (const url of ['', 'not a url', 'ftp://x', 'http://x/path', 'http://user:pw@x']) {
      const result = await run(['list'], { HULY_URL: url })
      assert.notEqual(result.code, 0, `accepted "${url}"`)
      assert.match(result.output, /HULY_URL/)
    }
  })
})

describe('credential files', () => {
  const uses = (file) => run(['list'], { HULY_URL: 'http://127.0.0.1:9', HULY_STATE_FILE: file })

  async function assertRefused (file, message) {
    const result = await uses(file)
    assert.notEqual(result.code, 0)
    assert.match(result.output, message)
    assertNoCredentials(result)
  }

  test('rejects a symbolic link', async () => {
    const link = path.join(dir, 'state-link')
    fs.symlinkSync(stateFile, link)
    await assertRefused(link, /symbolic link/)
  })

  test('rejects group or world access', async () => {
    await assertRefused(writeState('group-readable', undefined, 0o640), /too open/)
    await assertRefused(writeState('world-readable', undefined, 0o604), /too open/)
  })

  test('rejects a second hard link', async () => {
    const original = writeState('linked')
    fs.linkSync(original, path.join(dir, 'linked-2'))
    await assertRefused(original, /hard link/)
  })

  test('rejects a directory and a FIFO, without blocking', async () => {
    const directory = path.join(dir, 'a-directory')
    fs.mkdirSync(directory)
    await assertRefused(directory, /not a regular file/)
    const fifo = path.join(dir, 'a-fifo')
    execFileSync('mkfifo', [fifo])
    await assertRefused(fifo, /not a regular file/)
  })

  test('rejects a file under a directory others can write to', async () => {
    const shared = path.join(dir, 'shared')
    fs.mkdirSync(shared)
    fs.chmodSync(shared, 0o777)
    const file = path.join(shared, 'state')
    fs.writeFileSync(file, 'SMOKE_EMAIL=a\nSMOKE_PASSWORD=b\n', { mode: 0o600 })
    await assertRefused(file, /writable by others/)
  })

  test("rejects a file owned by another user", () => {
    assert.throws(() => readCredentialFile(stateFile, { uid: process.getuid() + 1 }), /owned by another user/)
  })

  test('does not repeat a value it cannot parse', async () => {
    const secret = 'unquoted secret value'
    const file = writeState('bad-format', `SMOKE_EMAIL=${EMAIL}\nSMOKE_PASSWORD=${secret}\n`)
    const result = await uses(file)
    assert.notEqual(result.code, 0)
    assert.match(result.output, /SMOKE_PASSWORD has unsupported shell quoting/)
    assert.ok(!result.output.includes(secret))
  })
})

describe('screenshot paths never touch the credential file', () => {
  const originalBytes = `SMOKE_EMAIL=${EMAIL}\nSMOKE_PASSWORD=${PASSWORD}\nSMOKE_WS_URL=team\n`

  async function assertRefused (credentialFile, output, message) {
    await withFake({}, async (fake) => {
      const result = await run(['phase0', '--expect-role', 'OWNER', '--screenshot', output], {
        HULY_URL: fake.url,
        HULY_STATE_FILE: credentialFile
      })
      assert.notEqual(result.code, 0, result.output)
      assert.match(result.output, message)
      assert.equal(fake.requests, 0, 'contacted the deployment')
    })
    assert.equal(fs.readFileSync(credentialFile, 'utf8'), originalBytes)
  }

  test('same path', async () => {
    const credential = writeState('cred-same.png')
    await assertRefused(credential, credential, /is the credential file/)
  })

  test('symbolic link to the credential file', async () => {
    const credential = writeState('cred-link.png')
    const link = path.join(dir, 'shot-link.png')
    fs.symlinkSync(credential, link)
    await assertRefused(credential, link, /symbolic link/)
  })

  test('parent symbolic link that leads to the credential file', async () => {
    const realDir = path.join(dir, 'real-dir')
    fs.mkdirSync(realDir)
    const credential = path.join(realDir, 'cred.png')
    fs.writeFileSync(credential, originalBytes, { mode: 0o600 })
    const linkDir = path.join(dir, 'link-dir')
    fs.symlinkSync(realDir, linkDir)
    await assertRefused(credential, path.join(linkDir, 'cred.png'), /is the credential file/)
  })

  test('existing output with another hard link', () => {
    const output = screenshotPath('hard-linked')
    fs.writeFileSync(output, 'x')
    fs.linkSync(output, path.join(dir, 'hard-linked-2'))
    const { identity } = readCredentialFile(stateFile)
    assert.throws(() => resolveOutputPath(output, identity), /hard link/)
  })

  test('a link planted after the path check is not followed', () => {
    const credential = writeState('cred-race')
    const { identity } = readCredentialFile(credential)
    const output = screenshotPath('race')
    const resolved = resolveOutputPath(output, identity)
    fs.symlinkSync(credential, output)
    assert.throws(() => writeOutputFile(resolved, Buffer.from('image'), identity))
    assert.equal(fs.readFileSync(credential, 'utf8'), originalBytes)
  })

  test('a hard link planted after the path check is refused before writing', () => {
    const credential = writeState('cred-race-hard')
    const { identity } = readCredentialFile(credential)
    const output = screenshotPath('race-hard')
    const resolved = resolveOutputPath(output, identity)
    fs.linkSync(credential, output)
    assert.throws(() => writeOutputFile(resolved, Buffer.from('image'), identity), /credential file/)
    assert.equal(fs.readFileSync(credential, 'utf8'), originalBytes)
  })

  test('rejects other extensions and a missing parent', () => {
    const { identity } = readCredentialFile(stateFile)
    assert.throws(() => resolveOutputPath(path.join(dir, 'shot.txt'), identity), /\.png/)
    assert.throws(() => resolveOutputPath(path.join(dir, 'missing', 'shot.png'), identity))
  })

  test('writes screenshots readable only by this user', () => {
    const { identity } = readCredentialFile(stateFile)
    const output = screenshotPath('private')
    writeOutputFile(resolveOutputPath(output, identity), Buffer.from('image'), identity)
    assert.equal(fs.statSync(output).mode & 0o777, 0o600)
    assert.equal(fs.readFileSync(output, 'utf8'), 'image')
  })
})

describe('state file format', () => {
  // Check against bash itself, so the decoder follows what printf %q really writes.
  for (const value of ['plain-Value_1', 'has space', "it's", 'back\\slash', 'line\nbreak', 'tab\there', '$HOME', 'åäö', 'a"b', '`x`;|&', '~tilde', '']) {
    test(`decodes bash printf %q of ${JSON.stringify(value)}`, () => {
      const quoted = execFileSync('bash', ['-c', 'printf %q "$1"', 'bash', value], { encoding: 'utf8' })
      assert.equal(decodeShellWord(quoted), value)
    })
  }

  test("decodes $'...' escapes", () => {
    assert.equal(decodeShellWord("$'a\\nb\\tc\\'d\\\\e\\x41\\101\\u00e5'"), "a\nb\tc'd\\eAAå")
    assert.equal(decodeShellWord("$'\\303\\245'"), 'å')
  })

  test('rejects forms it cannot decode exactly', () => {
    for (const word of ['"double"', "$'unterminated", "'unterminated", 'trailing\\', '$VAR', 'two words', "$'\\q'", "$'\\xff'", 'a;b']) {
      assert.throws(() => decodeShellWord(word), /unsupported shell quoting/, word)
    }
  })

  test('requires login fields and KEY=value lines', () => {
    assert.throws(() => parseStateText('SMOKE_EMAIL=a\n'), /no SMOKE_PASSWORD/)
    assert.throws(() => parseStateText("SMOKE_EMAIL=a\nSMOKE_PASSWORD=''\n"), /no SMOKE_PASSWORD/)
    assert.throws(() => parseStateText('SMOKE_EMAIL=a\nSMOKE_PASSWORD=b\nnot a pair\n'), /line 3/)
  })

  test('ignores blank lines and comments', () => {
    assert.deepEqual(parseStateText('# note\n\nSMOKE_EMAIL=a\nSMOKE_PASSWORD=b\n'), { SMOKE_EMAIL: 'a', SMOKE_PASSWORD: 'b' })
  })
})

test('parseArgs keeps flags and values apart', () => {
  const { options } = parseArgs(['phase0', '--expect-role', 'USER', '--screenshot', 'a.png', '--require-document-page'])
  assert.deepEqual(options, { 'expect-role': 'USER', screenshot: 'a.png', 'require-document-page': true })
})
