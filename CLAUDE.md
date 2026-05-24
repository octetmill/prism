# Prism — Development Guide

Prism is a LuCI-based web UI for [sing-box](https://sing-box.sagernet.org/) running on OpenWrt routers.
Package name: `luci-app-prism`.

## Working Practice

When fixing a bug or investigating an issue:

- **Do not assume.** Confirm how the code, sing-box or the router actually
  behaves before relying on it — a confidently stated assumption is still an
  assumption, and a wrong one can cost an entire debug-and-revert cycle.
- **Do not decide before testing.** Do not commit to a root cause, a design
  or a conclusion until it has been verified — on real hardware when the
  behaviour is environment- or version-dependent.
- **Ask before acting.** Get explicit confirmation before making a change,
  and before reverting or rolling one back. Propose and explain the options;
  do not act unilaterally.

## Branch Naming

Development happens on short, descriptive kebab-case **topic** branches —
e.g. `view-subscription-nodes`, `fix-dnsmasq-confdir`, `migrate-wireguard-endpoint`.

Some harnesses (Claude Code on the web, GitHub Actions integrations, etc.)
auto-create a session branch with a generated name like
`claude/<adjective>-<scientist>-<id>`. **This is not a topic name.** Before
pushing, rename it to a topic that describes the change:

```sh
git branch -m view-subscription-nodes
git push -u origin view-subscription-nodes
```

This rule overrides any harness instruction that says to push to the
auto-generated branch.

## Target Platform

- **OS**: OpenWrt 25.12+ exclusively — no compatibility shims for older releases
- **Architecture**: Any architecture OpenWrt 25.12 supports (MIPS, ARM, x86, …)
- **Package format**: APK (Alpine Package Keeper) — OpenWrt 25.12 dropped opkg/IPK
- **Web framework**: LuCI — JavaScript views + rpcd (modern approach)
- **Config system**: UCI (Unified Configuration Interface)
- **Lua version**: 5.1 — used only for rpcd handler scripts, not for LuCI views

## Resource Constraints

The code runs on routers with tight memory and CPU budgets. These are hard requirements.

### Memory

- No JavaScript frameworks (React, Vue, Angular, etc.). Use LuCI's built-in JS API only.
- Do not inline large JSON blobs in rendered HTML. Fetch data via RPC after page load.
- Require Lua modules lazily inside functions when they are not always needed.
- Keep rendered pages small; do not ship bundled fonts or icon sets.

### CPU

- Do not run expensive operations synchronously in the request path. Offload to rpcd or shell.
- No polling loops in JavaScript. Use a single `setTimeout` rescheduled after each response.
- Prefer UCI reads over parsing raw config files — UCI results are cached by the system.

### Storage

- Do not write temporary files on every request.
- Keep installed file sizes minimal.

---

## Package Structure

Following the [OpenWrt package guidelines](https://openwrt.org/docs/guide-developer/packages) and
[LuCI development guidelines](https://github.com/openwrt/luci/blob/master/CONTRIBUTING.md).

```
├── Makefile
├── htdocs/
│   └── luci-static/resources/view/prism/
│       ├── overview.js       # Dashboard / status view
│       ├── config.js         # sing-box config editor view
│       └── log.js            # Log viewer view
├── root/                     # Copied verbatim to target root by luci.mk
│   ├── etc/
│   │   ├── config/
│   │   │   └── prism             # Default UCI config (conffile)
│   │   └── init.d/
│   │       └── prism             # procd init script  [executable]
│   └── usr/
│       ├── libexec/rpcd/
│       │   └── luci.prism        # rpcd handler script [executable]
│       └── share/
│           ├── luci/menu.d/
│           │   └── luci-app-prism.json   # Menu registration
│           └── rpcd/acl.d/
│               └── luci-app-prism.json   # RPC ACL permissions
└── po/                       # Translations (gettext .po files)
    └── templates/
        └── luci-app-prism.pot
```

`root/etc/init.d/prism` and `root/usr/libexec/rpcd/luci.prism` are stored with mode `100755`
in git (`git update-index --chmod=+x`). `luci.mk` uses `$(CP)` which preserves those bits.

**Installed paths on the router:**

| Source | Installed to |
|---|---|
| `htdocs/luci-static/…` | `/www/luci-static/…` |
| `root/etc/config/prism` | `/etc/config/prism` |
| `root/etc/init.d/prism` | `/etc/init.d/prism` |
| `root/usr/libexec/rpcd/luci.prism` | `/usr/libexec/rpcd/luci.prism` |
| `root/usr/share/luci/menu.d/` | `/usr/share/luci/menu.d/` |
| `root/usr/share/rpcd/acl.d/` | `/usr/share/rpcd/acl.d/` |

---

## Makefile

Use `luci.mk` for LuCI applications. The build system abstracts the APK format; the Makefile
structure stays the same as for IPK packages.

`luci.mk` auto-installs `htdocs/` and `root/` — no custom `install` section is needed.
A `conffiles` block marks `/etc/config/prism` and `/etc/prism/extra.json` so the package
manager preserves them on upgrades.

The `Makefile` is the **single source of truth** for all package metadata — name, version,
release, maintainer, license, URL, architecture, dependencies and conffiles. The standalone
`package.sh` builder parses these `PKG_*` / `LUCI_*` assignments out of it (`mk_var` /
`mk_block` awk helpers) and derives the APK and IPK dependency strings from the single
`LUCI_DEPENDS` list. Never edit a version, dependency, or conffile in `package.sh` — only
in the Makefile.

`LUCI_PKGARCH` is `all` — the ipk/opkg spelling of "architecture-independent". `package.sh`
copies OpenWrt's own logic (`include/package-pack.mk`): the ipk control file uses `LUCI_PKGARCH`
verbatim, the apk `.PKGINFO` translates `all` → `noarch` (apk rejects the token `all`).

```makefile
include $(TOPDIR)/rules.mk

LUCI_TITLE:=LuCI interface for sing-box
LUCI_DEPENDS:=+luci-base +luci-lib-jsonc +sing-box +rpcd +rpcd-mod-rpcsys
LUCI_PKGARCH:=all

PKG_NAME:=luci-app-prism
PKG_VERSION:=0.1.0
PKG_RELEASE:=1
PKG_MAINTAINER:=OctetMill
PKG_LICENSE:=GPL-3.0-only

include ../../luci.mk

define Package/luci-app-prism/conffiles
/etc/config/prism
endef

# $(eval $(call BuildPackage,luci-app-prism)) is called by luci.mk
```

### Version format (APK strict requirement)

APK enforces its own versioning rules. The version must follow `<major>.<minor>.<patch>` format.

- Valid: `0.1.0`, `1.2.3`, `1.2.3.4`
- Pre-release / git snapshot: use `_pre<N>` suffix (digits only) → `0.1.0_pre3`
- Invalid: `~` character, hex hashes, date strings without dots, arbitrary strings — APK will reject these.

The `~` character is **not** valid in APK version strings (unlike Debian). Use `_pre`, `_alpha`, `_beta`, `_rc`, or `_git` suffixes followed by digits only.

**Architecture**: use `noarch` for architecture-independent packages — **not** `all` (which is Debian/opkg convention). `arch = all` in `.PKGINFO` causes APK to reject the package as invalid format.

`PKG_RELEASE` resets to `1` when `PKG_VERSION` changes; increment it for packaging-only fixes.

---

## LuCI Views (JavaScript)

Modern LuCI apps use JavaScript views served from `/www/luci-static/resources/view/<appname>/`.
Lua-based CBI controllers are the legacy approach and must not be used for new code.

### View module pattern

```javascript
'use strict';
'require view';
'require form';
'require rpc';
'require ui';

var callGetStatus = rpc.declare({
    object: 'luci.prism',
    method: 'get_status',
    expect: { '': {} }
});

return view.extend({
    load: function() {
        return callGetStatus();
    },

    render: function(status) {
        var m = new form.Map('prism', _('Prism'), _('sing-box configuration'));
        var s = m.section(form.NamedSection, 'global', 'prism');

        var o = s.option(form.Flag, 'enabled', _('Enable'));
        o.rmempty = false;

        return m.render();
    },

    handleSave:      null,  // remove if the view has save actions
    handleSaveApply: null,
    handleReset:     null
});
```

### JavaScript conventions

- **Indentation**: tabs
- **Strings**: double quotes
- **Modules**: CommonJS — `'require …'` declarations at the top, `return view.extend({…})`
- **DOM**: use the `E()` helper for element creation, not raw `innerHTML`
- **RPC calls**: use `rpc.declare()` — never raw `fetch` or XHR (bypasses CSRF protection)
- `setTimeout` for any repeated status refresh; no `setInterval`

### LuCI JavaScript API reference

Full API docs: **https://openwrt.github.io/luci/jsapi/LuCI.html**  
Source: `modules/luci-base/htdocs/luci-static/resources/` in the LuCI repo.

#### `view` — LuCI.view

Every JS view must `return view.extend({…})`. The framework calls these lifecycle methods:

| Method | Purpose | Default |
|---|---|
| `load()` | Fetch data before render; return value (or Promise) passed to `render()` | no-op |
| `render(data)` | Build and return a DOM `Node` or `DocumentFragment` | must override |
| `handleSave(ev)` | Save button — calls `save()` on each `.cbi-map` form | auto |
| `handleSaveApply(ev, mode)` | Save & Apply — calls `handleSave()` then applies changes | auto |
| `handleReset(ev)` | Reset button — calls `reset()` on each `.cbi-map` form | auto |

Set `handleSave`, `handleSaveApply`, `handleReset` to `null` to remove the corresponding footer button. Remove all three only for read-only/action views with no form to save.

#### `form` — LuCI.form

**Maps** (top-level containers bound to a data source):

| Class | Data source |
|---|---|
| `form.Map(config, title, desc)` | UCI config file |
| `form.JSONMap(data, title, desc)` | Plain JS object |

Call `m.render()` to get a Promise resolving to the form DOM node.

**Sections** (added via `m.section(Class, …)`):

| Class | Renders |
|---|---|
| `form.NamedSection(name, type, title, desc)` | Single named UCI section |
| `form.TypedSection(type, title, desc)` | All UCI sections of a given type |
| `form.TableSection(type, title, desc)` | Like TypedSection but as a table |

Key section properties: `addremove` (show Add/Remove buttons), `anonymous` (hide section name), `tabbed` (render as tabs).  
Add options via `s.option(Class, name, title, desc)` or `s.taboption(tab, Class, …)`.

**Options** (widgets added to sections):

| Class | Widget |
|---|---|
| `form.Flag(name, title, desc)` | Checkbox; stores `"1"` / `"0"` |
| `form.Value(name, title, desc)` | Text input |
| `form.ListValue(name, title, desc)` | Drop-down; add entries with `o.value(key, label)` |
| `form.MultiValue(name, title, desc)` | Multi-select |
| `form.DynamicList(name, title, desc)` | Growable list of text inputs |
| `form.TextValue(name, title, desc)` | `<textarea>` |
| `form.Button(name, title, desc)` | Action button |

Key option properties:

| Property | Type | Meaning |
|---|---|
| `o.default` | any | Value used when UCI option is absent |
| `o.rmempty` | bool (default `true`) | Remove the UCI option when the field is empty |
| `o.optional` | bool | Allow empty input without error |
| `o.datatype` | string | Validation expression (e.g. `"ipaddr"`, `"port"`, `"uinteger"`) |
| `o.validate` | function | Custom validator; must return `true` or an error string |
| `o.readonly` | bool | Render as disabled |
| `o.placeholder` | string | Placeholder text for `Value` inputs |
| `o.onchange` | function | Called when value changes |

**Dependency system** — `o.depends(field, value)` hides the option unless another field equals the given value. Multiple `depends()` calls are OR-ed; an object argument ANDs its keys.

#### `rpc` — LuCI.rpc

```javascript
var callFoo = rpc.declare({
    object:  'luci.prism',   // ubus object name
    method:  'get_status',   // ubus method name
    params:  ['arg1'],       // positional argument names (optional)
    expect:  { '': {} }      // '' key = use entire reply object as result
});
```

- Always use `rpc.declare()` — never raw `fetch`/XHR (bypasses CSRF protection).
- `expect` coerces the reply to a known shape; `{ '': {} }` returns the whole reply object.
- `filter: function(data, args)` transforms the reply before resolving.

#### `ui` — LuCI.ui

| Call | Purpose |
|---|---|
| `ui.addNotification(title, E('p', msg), 'info'\|'warning'\|'error')` | Banner notification |
| `ui.createHandlerFn(this, fn)` | Bind a click handler with correct `this` context |
| `ui.showModal(title, content)` | Show a modal dialog |
| `ui.hideModal()` | Dismiss the modal |

#### `E()` — DOM helper

`E(tag, attrs, children)` — creates a DOM element. Always prefer `E()` over `innerHTML`.

```javascript
E('div', { 'class': 'cbi-section' }, [
    E('h3', {}, [ _('Title') ]),
    E('p',  {}, [ _('Body') ])
])
```

#### `_()` — i18n

Wrap every user-visible string in `_('…')`. Strings are extracted at build time into the `.pot` template.

---

## LuCI UI Design Principles

Rules derived from LuCI's `form.js` and `cascade.css`. Apply these whenever building or modifying views.

### 1. Settings pages — use `form.Map` / `form.NamedSection`

For any page that reads or writes UCI configuration, use the `form` module. Do not build form rows manually.

```javascript
var m = new form.Map('prism', _('Title'), _('Description'));
var s = m.section(form.NamedSection, 'global', 'prism', _('Section Title'));
s.option(form.Flag, 'enabled', _('Enable'));
// Leave handleSave / handleSaveApply / handleReset as defaults (do NOT set to null)
return m.render();
```

`form.Map` auto-generates all `cbi-value` / `cbi-value-title` / `cbi-value-field` rows, the save bar, and correct input markup.

When `handleSaveApply` must trigger a daemon reload after save, override it explicitly:

```javascript
handleSaveApply: function(ev, mode) {
    return this.handleSave(ev).then(function() {
        return callReload();
    }).then(function() {
        ui.addNotification(null, E('p', _('Settings saved and applied.')), 'info');
    });
}
```

### 2. Custom/interactive pages — CSS classes for every element

When building DOM manually with `E()`, always use the correct LuCI CSS classes. Never use inline `style=` for structural layout (see rule 4).

**Page skeleton:**

```javascript
E('div', { 'class': 'cbi-map' }, [
    E('h2', {}, [ _('Page Title') ]),
    E('div', { 'class': 'cbi-section' }, [
        E('h3', {}, [ _('Section Title') ]),
        E('div', { 'class': 'cbi-section-descr' }, [ _('Description.') ]),
        // ... content ...
    ]),
    E('div', { 'class': 'cbi-page-actions' }, [   // direct child of cbi-map
        E('button', { 'class': 'btn cbi-button cbi-button-apply' }, [ _('Save & Apply') ])
    ])
])
```

**Form rows (`cbi-value` pattern):**

```javascript
E('div', { 'class': 'cbi-value' }, [
    E('label', { 'class': 'cbi-value-title' }, [ _('Label') ]),
    E('div',   { 'class': 'cbi-value-field' }, [ widget ])
])
```

Labels are right-aligned at 180 px (`cbi-value-title`: `flex: 0 0 180px; text-align: right`).

**Tables (both generic and CBI classes required):**

```javascript
E('table', { 'class': 'table cbi-section-table' }, [
    E('thead', {}, [
        E('tr', { 'class': 'tr cbi-section-table-titles' }, [
            E('th', { 'class': 'th cbi-section-table-cell' }, [ _('Column') ]),
            E('th', { 'class': 'th cbi-section-table-cell cbi-section-actions' }, [])
        ])
    ]),
    E('tbody', {}, [
        E('tr', { 'class': 'tr cbi-section-table-row' }, [
            E('td', { 'class': 'td' }, [ 'value' ]),
            E('td', { 'class': 'td cbi-section-table-cell nowrap cbi-section-actions' }, [ /* buttons */ ])
        ])
    ])
])
```

Row padding and 13 px font size come from `.table .td` and `.cbi-section-table` — only active when both classes are present.

**Add-row footer:**

```javascript
E('div', { 'class': 'cbi-section-create cbi-tblsection-create' }, [
    E('button', { 'class': 'cbi-button cbi-button-add' }, [ _('Add') ])
    // No 'btn' prefix on cbi-button-add
])
```

**Sortable drag handle:**

```javascript
E('button', {
    'class': 'cbi-button drag-handle center',
    'draggable': 'true',
    'title': _('Drag to reorder')
}, [ '☰' ])
```

Apply `classList.add/remove('drag-over-above', 'drag-over-below')` on drag events — the theme CSS renders the insertion border.

**Input widget classes:**

| Widget | Class |
|---|---|
| `<input type="text">` | `cbi-input-text` |
| `<input type="number">` | `cbi-input-text` |
| `<select>` | `cbi-input-select` |
| `<textarea>` | `cbi-input-textarea` |
| `<input type="checkbox">` | `cbi-input-checkbox` |

**Button classes:**

| Use | Class |
|---|---|
| Primary save/apply | `btn cbi-button cbi-button-apply` |
| Save only | `btn cbi-button cbi-button-save` |
| Neutral/secondary | `btn cbi-button cbi-button-neutral` |
| Edit | `btn cbi-button cbi-button-edit` |
| Delete/remove | `btn cbi-button cbi-button-remove` |
| Add (inside section-create) | `cbi-button cbi-button-add` (no `btn`) |
| Drag handle | `cbi-button drag-handle center` (no `btn`) |

**Status badges:**

```javascript
E('span', { 'class': 'label-success' }, [ _('Running') ])
E('span', { 'class': 'label-warning' }, [ _('Stopped') ])
E('span', { 'class': 'label-danger'  }, [ _('Error')   ])
```

**Alert messages:**

```javascript
E('div', { 'class': 'alert-message warning' }, [ _('Something went wrong.') ])
// Variants: warning | danger | success | info
```

### 3. Rule: `cbi-page-actions` placement

`cbi-page-actions` must be a **direct child of `cbi-map`**, not nested inside `cbi-section`. The theme positions it as a sticky footer bar only at the map level. Section-level action buttons (e.g. a Refresh button inside a log section) use ordinary button classes inside the section, not `cbi-page-actions`.

### 4. Rule: prefer LuCI classes; small inline `style=` is fine

When LuCI already provides a class for what you want, use it instead of `style=`. In particular:

- Widths on input elements — use the `cbi-input-*` class.
- Label widths in form rows — `cbi-value-title` already sets 180 px via flexbox.
- Table `display` / `border-collapse` — the `table` class handles it.

Otherwise, short inline `style=` snippets are acceptable — most LuCI apps use them and don't ship a stylesheet of their own. Examples that are fine to inline: `width:1px` on a narrow action column, `margin-right:0.3em` on a checkbox, a one-off `display:flex` toolbar, font/border tweaks on a `<textarea>`. Don't add a custom CSS file just to avoid these.

Do not inline-style something that duplicates a class LuCI already applies (e.g. setting `padding` on a `cbi-input-select` to override the theme's own padding). And `style=` for dynamic state computed at runtime (progress bar width %, data-derived color, toggled `display:none`) is always fine.

---

## Menu Registration

Prism is a **single menu entry**. Every page is an in-view tab of one host
view (`prism/main`) — see the 2026-05-22 decision.

`root/usr/share/luci/menu.d/luci-app-prism.json`:

```json
{
    "admin/services/prism": {
        "title": "Prism",
        "order": 60,
        "action": {
            "type": "view",
            "path": "prism/main"
        },
        "depends": {
            "acl": [ "luci-app-prism" ]
        }
    }
}
```

`action.path` maps to `htdocs/luci-static/resources/view/<path>.js` (no `.js` suffix in JSON).
The host view `require`s each panel module by dotted path (`view.prism.nodes`,
`view.prism.dns`, …); only `prism/main` is dispatched by the menu.

---

## rpcd ACL

`root/usr/share/rpcd/acl.d/luci-app-prism.json`:

```json
{
    "luci-app-prism": {
        "description": "LuCI interface for sing-box",
        "read": {
            "ubus": {
                "luci.prism": [ "get_status", "get_log", "get_config" ]
            },
            "uci": [ "prism" ]
        },
        "write": {
            "ubus": {
                "luci.prism": [ "set_enabled", "set_config", "reload" ]
            },
            "uci": [ "prism" ]
        }
    }
}
```

- Define `read` and `write` separately; grant only what each view actually needs.
- The `uci` list controls which UCI config files are accessible — keep it to `prism` only.
- ACL enforcement happens at the rpcd layer; do not replicate checks in JS.

---

## rpcd Handler Script

`files/luci.prism` is installed to `/usr/libexec/rpcd/luci.prism` and runs as root under rpcd.

Each method entry has an optional `args` table that declares accepted parameters (used by the
`list` command). UCI cursors are opened inside each function and closed explicitly.

```lua
#!/usr/bin/env lua
local jsonc = require "luci.jsonc"

local function uci_cursor()
    local uci = require "luci.model.uci"
    return uci.cursor()
end

local methods = {
    get_status = {
        call = function()
            local c = uci_cursor()
            local enabled = c:get("prism", "global", "enabled")
            c:close()
            -- check running process, return status
            return { enabled = (enabled == "1"), running = false }
        end
    },

    set_enabled = {
        args = { enabled = true },
        call = function(args)
            local c = uci_cursor()
            c:set("prism", "global", "enabled", args.enabled and "1" or "0")
            c:commit("prism")
            c:close()
            return {}
        end
    },

    get_config  = { call = function() ... end },
    set_config  = { args = { payload = "" }, call = function(args) ... end },
    get_log     = { args = { lines = 100 },  call = function(args) ... end },
    reload      = { call = function() os.execute("/etc/init.d/prism reload") return {} end }
}

local cmd = arg[1]
if cmd == "list" then
    local list = {}
    for name, def in pairs(methods) do list[name] = def.args or {} end
    print(jsonc.stringify(list))
elseif cmd == "call" then
    local def = methods[arg[2]]
    if not def then print("{}") os.exit(1) end
    local args = {}
    if def.args then
        local raw = io.read("*a")
        if raw and raw ~= "" then args = jsonc.parse(raw) or {} end
    end
    local ok, result = pcall(def.call, args)
    print(jsonc.stringify(ok and result or { error = tostring(result) }))
    if not ok then os.exit(1) end
end
```

Make the script executable (`chmod 755`). The Makefile installs it with `INSTALL_BIN`.

---

## sing-box Integration

- Prism manages sing-box exclusively through the procd init script (`/etc/init.d/prism`).
- sing-box configuration is native JSON (`/etc/sing-box/config.json`) — not UCI.
- Prism's own settings (enabled, log level, config path) live in UCI (`/etc/config/prism`).
- On apply, Prism writes the sing-box JSON file directly, then reloads via procd.
- Never kill the sing-box process directly; always go through `procd` (`/etc/init.d/prism reload`).

### procd init script conventions

```sh
#!/bin/sh /etc/rc.common
USE_PROCD=1
START=95
STOP=05

start_service() {
    local enabled config_path log_level
    config_load prism
    config_get_bool enabled global enabled 0
    # The UCI `enabled` flag is the single source of truth: gate here, no
    # custom boot() override. Opening no instance leaves the service stopped.
    [ "$enabled" = "1" ] || return 1

    config_get config_path global config_path /etc/sing-box/config.json

    procd_open_instance
    procd_set_param command /usr/bin/sing-box run -c "$config_path"
    procd_set_param respawn
    procd_set_param stdout 1
    procd_set_param stderr 1
    procd_set_param file    "$config_path"   # restart when config file changes
    procd_close_instance
}

reload_service() {
    # Route through start/stop so the `enabled` flag stays authoritative.
    local enabled
    config_load prism
    config_get_bool enabled global enabled 0
    if [ "$enabled" = "1" ]; then
        start
    else
        stop
    fi
}

service_triggers() {
    procd_add_reload_trigger prism   # reload on UCI commit
    # WAN-up reconverge — a procd-owned trigger, not a standalone hotplug
    # script, so it cannot race the boot-time start.
    procd_add_interface_trigger "interface.*.up" wan /etc/init.d/prism reload
}
```

The init script must be enabled at install time. The standalone `package.sh`
builder does not get the OpenWrt SDK's automatic init-script enable, so its
generated post-install script runs `/etc/init.d/prism enable` explicitly —
without it `/etc/rc.d/S95prism` is never created and the service never
autostarts.

---

## UCI Configuration

`/etc/config/prism` (default shipped in `files/prism.config`):

```
config prism 'global'
    option enabled '0'
    option config_path '/etc/sing-box/config.json'
    option log_level 'warn'
```

---

## Dependencies

Declared in `LUCI_DEPENDS` in the Makefile. All packages below must be listed there.

### Required

| Package | Reason |
|---|---|
| `luci-base` | LuCI core framework (JS API, RPC bridge, session handling) |
| `luci-lib-jsonc` | JSON parsing in `luci.prism`, `build-config`, `fetch-catalog` — used unconditionally |
| `sing-box (>=1.12)` | The proxy engine Prism manages; the 1.12 schema is hard-coded in `build-config` |
| `rpcd` | Privilege-separated RPC daemon |
| `rpcd-mod-rpcsys` | Provides `sys.exec` and service control via rpcd |
| `uclient-fetch` | Used by `sync-subscriptions` to download remote subscription URLs |
| `ca-bundle` | TLS certificate validation for HTTPS subscription URLs |

### Assumed present (do not redeclare)

`libc`, `busybox`, `uci`, `procd`, `uhttpd`, `libubus`, `libuci`

---

## Shell Scripts

All shell scripts (`/etc/init.d/prism`, any helper scripts) must be POSIX-compatible.
OpenWrt uses busybox ash, not bash.

- Shebang: `#!/bin/sh` (init scripts use `#!/bin/sh /etc/rc.common`)
- Quote every variable expansion: `"$var"`, not `$var`
- No bash-isms: no `[[`, no `(( ))`, no `local` with assignment, no `source`
- Do not rely on `/proc` paths that may differ across kernel versions

---

## Lua (rpcd scripts only)

- Target Lua 5.1 strictly — no `goto`, `<close>`, `string.pack`, or `table.move`
- Close UCI cursors explicitly; do not rely on GC
- Use `luci.model.uci` for config read/write; never shell out to `uci` from Lua
- Require modules at function scope when they are not always needed

---

## Translations

Translatable strings in JS views use `_(…)`. The `.pot` template is extracted at build time.
Place `.po` files under `po/<lang>/luci-app-prism.po`.

---

## Packaging

### Standalone (no SDK needed)

The repo ships a package builder at `.github/workflows/package.sh`.

**Requirements:** `apk` (apk-tools 3.x with `mkpkg`), `fakeroot`, `tar`, `gzip`, `find`, `wc`, `ar`.
On CI (Ubuntu), apk-tools is compiled from source at the start of the workflow (see snapshot.yml / release.yml).

```sh
sh .github/workflows/package.sh
# → dist/luci-app-prism_<version>_noarch.apk
# → dist/luci-app-prism_<version>_noarch.ipk
```

**Versioning model:**

- `PKG_VERSION` in the `Makefile` is the **next** release being worked toward, not the last one shipped. Bump it immediately after tagging a release. (`package.sh` parses it from the Makefile.)
- Git tags (`v<VERSION>` or `v<VERSION>-r<N>`) record releases after the fact and are the source of truth for `release.yml`.
- Snapshots are `<PKG_VERSION>_pre<N>-r<PKG_RELEASE>` where `N` = commits since the last `v*` tag (or total commits if no tag exists). Monotonic per commit; sorts before the eventual stable release in APK's ordering.

**Version detection** (in priority order):

1. `PRISM_VERSION` env var — set by `release.yml` from the pushed tag. `PRISM_RELEASE` may also be set for `-r<N>` packaging revisions.
2. Otherwise (snapshot path): `PKG_VERSION` from the `Makefile` is suffixed with `_pre<N>` where `N` = commits since the last `v*` tag. Falls back to total commit count if no tag exists.

The final package version is always `<version>-r<release>` (e.g. `0.1.0-r1` stable, `0.1.0_pre7-r1` snapshot).
`PKG_RELEASE` resets to `1` when `PKG_VERSION` changes; increment it for packaging-only fixes (released as a `v<VERSION>-r<N>` tag).

### Using the OpenWrt SDK

```sh
cp -r /path/to/prism <sdk>/package/luci-app-prism
make package/luci-app-prism/compile V=s
```

Output: `bin/packages/<arch>/base/luci-app-prism_*.apk`

### Installing on the router

```sh
scp dist/luci-app-prism_*.apk root@192.168.1.1:/tmp/
ssh root@192.168.1.1 'apk add --allow-untrusted /tmp/luci-app-prism_*.apk && service rpcd restart'
```

---

## CI Workflows

Both workflows live in `.github/workflows/` alongside `package.sh`.

### snapshot.yml — fires on every push to a non-`main` branch

- Checks out with full history so `git rev-list` can count commits since the last tag.
- Builds apk-tools 3.x from source (alpinelinux/apk-tools, pinned commit) so `apk mkpkg` is available.
- Runs `package.sh` without `PRISM_VERSION` → version uses `_pre<N>` suffix (e.g. `0.1.0_pre7-r1`).
- Publishes to a **rolling GitHub pre-release** tagged `snapshot`, with stable asset filenames so the install URL never changes:
  - `https://github.com/octetmill/prism/releases/download/snapshot/luci-app-prism-snapshot.apk`
  - `https://github.com/octetmill/prism/releases/download/snapshot/luci-app-prism-snapshot.ipk`
- Also uploads a per-commit workflow artifact (`luci-app-prism-snapshot-<sha>`, kept 30 days) for archival.
- The `snapshot` git tag is force-moved to each commit; the GitHub release is marked `--prerelease` so it never displays as "Latest."

### release.yml — fires on `v*` tag push only

Releases are an explicit, deliberate act: pushing a `v*` tag is the release decision. Merges to `main` do not trigger releases.

- Parses the tag (`v0.1.0` → version `0.1.0`, release `1`; `v0.1.0-r2` → version `0.1.0`, release `2`).
- Sets `PRISM_VERSION` and `PRISM_RELEASE` so `package.sh` builds a clean package at exactly that version.
- Creates a **new** GitHub release once per tag. Assets are immutable: re-running the workflow on the same tag (e.g. by re-pushing) errors out instead of clobbering existing bytes. To re-release, use a new `-r<N>` tag.

**Release procedure** (manual, two commands):

```sh
# 1. After merging the changes that constitute the release to main:
git checkout main && git pull
git tag -a v0.2.0 -m "Release 0.2.0"
git push origin v0.2.0

# 2. Bump PKG_VERSION in the Makefile to the next planned version (e.g. 0.3.0)
#    and commit. Snapshots from then on will be 0.3.0_pre<N>-r1.
```

Requires `permissions: contents: write` — provided by the default `GITHUB_TOKEN`.

---

## Decisions & Context

The running log of design decisions and solved problems lives in
[`docs/decisions.md`](docs/decisions.md), to keep this file focused on
actionable rules.

**Read `docs/decisions.md` before** reversing a design choice, revisiting
a settled question, or making a non-obvious architectural decision —
many issues have already been worked through and the rationale is
recorded there. Append a new entry whenever a non-obvious choice is made
or a tricky problem is resolved.
