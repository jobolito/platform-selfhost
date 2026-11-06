// A small stand-in for a deployment, used only by workspace-config.node-test.cjs.
// It serves the markup the tool reads, with options that make it misbehave in specific ways.
// All data is synthetic. It listens on loopback and talks to nothing else.

const http = require('http')
const contract = require('../phase0-contract.json')

const DEFAULT_RAIL = [
  'workbench:string:HideMenu', 'notification:string:Inbox', 'time:string:Planner', 'card:string:Cards',
  'contact:string:Contacts', 'chunter:string:Chat', 'tracker:string:Tracker', 'document:string:Documents',
  'time:string:Team', 'drive:string:Drive', 'setting:string:Customize', 'support:string:ContactUs',
  'calendar:string:Calendar'
]

function defaultPlugins () {
  return Object.fromEntries([
    ...contract.pluginsOn.map((name) => [name, true]),
    ...contract.pluginsOff.map((name) => [name, false])
  ])
}

const page = `<!doctype html><title>fake</title><style>button{display:block}</style><body><div id=root></div><script>
(async () => {
  const cfg = await (await fetch('/__config')).json()
  const root = document.getElementById('root')
  const rpc = async (method, params) => (await fetch('/_accounts', { method: 'POST', body: JSON.stringify({ method, params }) })).json()
  const path = () => decodeURIComponent(location.pathname)
  if (cfg.crash) setTimeout(() => { throw new Error('synthetic crash') }, 0)
  if (cfg.serverError) fetch('/__broken')

  if (path().startsWith('/login/login')) {
    root.innerHTML = '<input name=email><input name=current-password type=password><button>Log In</button>'
    root.querySelector('button').onclick = async () => { await rpc('login', {}); location.href = '/login/selectWorkspace' }
    return
  }
  if (path().startsWith('/login/')) { root.textContent = 'select workspace'; return }

  const slug = path().split('/')[2]
  await rpc('selectWorkspace', { workspaceUrl: slug })
  let navVisible = true

  function render () {
    const parts = path().split('/')
    const app = parts[3]
    const rail = cfg.rail.map((id) => '<button id="app-' + id + '">' + id + '</button>').join('')
    let nav = ''
    let main = ''
    if (app === 'setting') {
      main = cfg.role === 'OWNER' ? cfg.plugins.map(([name, on]) =>
        '<div class="plugin-card ' + (on ? 'enabled' : '') + '"><span class=plugin-card__name>' + name + '</span>' +
        '<label class=toggle data-name="' + name + '" data-on="' + on + '">t</label></div>').join('') : 'forbidden'
    } else if (app !== undefined) {
      const title = cfg.titles[app] ?? app
      const docs = Array.from({ length: cfg.documents }, (_, i) => '<button class=hulyNavItem-container data-doc=' + i + '>doc ' + i + '</button>').join('')
      if (navVisible && !cfg.emptyNavigator) {
        nav = '<div class=hulyNavPanel-header>' + title + '</div><div>Teamspaces and more navigator text</div>' +
          (app === 'document' ? '<div class=hulyNavGroup-container>' + docs + '</div>' : '')
      }
      if (app === 'document' && parts[4] === 'core:space:Workspace' && !cfg.blankPage) {
        const rows = Array.from({ length: cfg.rows }, () => '<tr><td>row</td></tr>').join('')
        main = '<div>Teamspaces</div><table class=antiTable><thead><tr><th>h</th></tr></thead><tbody>' + rows + '</tbody></table>'
      } else if (app === 'document' && parts[4]?.startsWith('doc')) {
        main = '<div contenteditable=true>' + (cfg.blankDocument ? '' : 'synthetic document text') + '</div>'
      }
    }
    if (cfg.todayInPage) main += '<div>Today</div><div>10:00 11:00 12:00</div>'
    root.innerHTML = '<div id=rail>' + rail + '</div><div class=antiPanel-navigator>' + nav + '</div><div class=hulyComponent>' + main + '</div>' +
      (window.calendarOpen ? calendar() : '')
  }

  function calendar () {
    const hours = cfg.calendar === 'no-grid' ? '' : ['1am', '2am', '3am', '4am'].map((h) => '<div class=time-cell>' + h + '</div>').join('')
    return '<div class=sidebar-content><div class=calendar-container style="width:100px;height:100px">' + hours + '</div></div>'
  }

  const go = (to) => { history.pushState({}, '', to); render() }

  root.onclick = async (event) => {
    const button = event.target.closest('button')
    const label = event.target.closest('label.toggle')
    if (label != null) {
      await fetch('/__toggle', { method: 'POST', body: JSON.stringify({ name: label.dataset.name, enabled: label.dataset.on !== 'true' }) })
      location.reload()
    } else if (button?.dataset.doc !== undefined) {
      go('/workbench/' + slug + '/document/doc-' + button.dataset.doc)
    } else if (button?.id.startsWith('app-')) {
      const app = button.id.slice(4).split(':')[0]
      if (app === 'calendar') {
        if (cfg.calendar !== 'none') { window.calendarOpen = true; render() }
      } else if (app === path().split('/')[3]) {
        navVisible = !navVisible
        render()
      } else {
        go('/workbench/' + slug + '/' + (cfg.wrongRoute?.[app] ?? app))
      }
    }
  }

  if (path().replace(/\\/$/, '') === '/workbench/' + slug) history.replaceState({}, '', '/workbench/' + slug + '/' + cfg.landing)
  render()
})()
</script>`

async function startFakeHuly (options = {}) {
  const config = {
    workspace: 'team',
    selectedWorkspace: undefined,
    role: 'OWNER',
    landing: contract.landingPath,
    rail: DEFAULT_RAIL,
    titles: Object.fromEntries(contract.apps.map((app) => [app.id, app.navigatorTitle])),
    rows: 1,
    documents: 2,
    calendar: 'ok',
    persist: true,
    revertOnLogin: false,
    ...options
  }
  const initial = { ...defaultPlugins(), ...config.plugins }
  let plugins = { ...initial }
  const fake = { requests: 0, toggles: [], logins: 0, plugins: () => plugins }

  const server = http.createServer((req, res) => {
    fake.requests++
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      const send = (code, type, text) => { res.writeHead(code, { 'Content-Type': type }); res.end(text) }
      const json = (value) => send(200, 'application/json', JSON.stringify(value))
      if (req.url === '/__config') {
        return json({ ...config, plugins: Object.entries(plugins) })
      }
      if (req.url === '/__broken') return send(500, 'text/plain', 'broken')
      if (req.url === '/__toggle') {
        const { name, enabled } = JSON.parse(body)
        fake.toggles.push({ name, enabled })
        if (config.persist) plugins[name] = enabled
        return json({})
      }
      if (req.url === '/_accounts') {
        const { method, params } = JSON.parse(body)
        if (method === 'login') {
          fake.logins++
          if (config.revertOnLogin && fake.logins > 1) plugins = { ...initial }
          return json({ result: {} })
        }
        return json({ result: { workspaceUrl: config.selectedWorkspace ?? params.workspaceUrl, role: config.role } })
      }
      send(200, 'text/html', page)
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  fake.url = `http://127.0.0.1:${server.address().port}`
  fake.stop = () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve) })
  return fake
}

module.exports = { startFakeHuly }
