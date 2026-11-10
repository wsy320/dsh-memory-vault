/**
 * Memory Vault — settings page.
 *
 * One page in **设置 → 记忆库** that edits the Host plugin's own Config, so the
 * vault folder is picked in the UI instead of in `cordis.patch.yml`. The Host
 * declares the field `.volatile()`, and a volatile write re-applies the plugin
 * in place, so saving here is live: the memory tools and the system-prompt
 * section pick the new folder up without restarting the app.
 *
 * Plain JavaScript, no build step: the browser loads this file through
 * `window.__ModuleLoader__`, whose factory id must equal the package name.
 *
 * @module dsh-memory-vault/client
 */
window.__ModuleLoader__.load({
  id: '@wsy320/dsh-memory-vault',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { Button, Input, Tag } = require('@deepseek-ai/dsh-client-ui-primitives')

    /** Settings namespace — the profile entry id from `cordis.patch.yml`. */
    const NS = 'dsh-memory-vault'
    /**
     * Mirrors the Host's default. The Client half cannot import `lib/sync.js`
     * (the browser loads only this file), so the number is repeated here and used
     * only as the display default before the Host's value arrives.
     */
    const DEFAULT_SYNC_INTERVAL_SECONDS = 300

    const ZH = {
      'section.title': '记忆库',
      'section.subtitle': '个人的长期记忆库。交给 agent 检索与写入，也可以在这里换一个库目录。',
      'field.vault': '库目录',
      'field.vaultHint': '记忆库文件夹的绝对路径。保存后立即生效，无需重启。',
      'section.sync': '自动同步',
      'field.syncEnabled': '启用自动同步',
      'field.syncEnabledHint': '启动时拉取一次；之后按下面的间隔先拉取、再提交并推送。库目录不是 git 仓库时自动跳过。',
      'field.syncInterval': '同步间隔（秒）',
      'field.syncIntervalHint': '最短 60 秒，默认 300 秒（5 分钟）。',
      'field.intervalInvalid': '间隔必须是不小于 60 的整数。',
      'status.saved': '已配置',
      'status.unset': '还没配置库目录',
      'action.save': '保存',
      'action.saving': '保存中...',
      'action.saved': '已保存，agent 正在使用新路径',
      'action.failed': '保存失败，请刷新后重试',
      'empty.unavailable': '设置服务不可用，无法修改配置。',
    }

    const EN = {
      'section.title': 'Memory Vault',
      'section.subtitle': 'Your long-term personal memory vault, used by the agent for recall and writes. Pick the folder here.',
      'field.vault': 'Vault folder',
      'field.vaultHint': 'Absolute path of the memory vault folder. Saving takes effect immediately, no restart.',
      'section.sync': 'Automatic sync',
      'field.syncEnabled': 'Enable automatic sync',
      'field.syncEnabledHint': 'Pull once at startup, then pull, commit, and push on the interval below. Skipped when the folder is not a git repository.',
      'field.syncInterval': 'Sync interval (seconds)',
      'field.syncIntervalHint': 'Minimum 60 seconds; defaults to 300 (5 minutes).',
      'field.intervalInvalid': 'The interval must be an integer of at least 60.',
      'status.saved': 'Configured',
      'status.unset': 'No vault folder configured yet',
      'action.save': 'Save',
      'action.saving': 'Saving...',
      'action.saved': 'Saved. The agent is using the new path.',
      'action.failed': 'Save failed; refresh and retry',
      'empty.unavailable': 'The settings service is unavailable, so the configuration cannot be edited.',
    }

    const STYLE = [
      '.dmv-root{display:flex;flex-direction:column;gap:8px;max-width:640px}',
      '.dmv-title{margin:0;font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.dmv-subtitle{margin:0;font-size:13px;color:var(--dsw-alias-label-secondary)}',
      '.dmv-label{margin-top:8px;font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary)}',
      '.dmv-hint{margin:0;font-size:12px;color:var(--dsw-alias-label-tertiary)}',
      '.dmv-error{margin:0;font-size:12px;color:var(--dsw-alias-label-warning,#d9534f)}',
      '.dmv-row{display:flex;align-items:center;gap:10px;margin-top:12px}',
      '.dmv-check{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--dsw-alias-label-primary);cursor:pointer;margin-top:4px}',
    ].join('\n')

    /**
     * Render the settings page.
     *
     * Three fields share one draft and one Save: the vault folder, whether
     * automatic sync runs, and how often. Reads come from the shared config form
     * for this entry; the write is fenced by the form's revision, so a stale save
     * is refused by the Host and reported instead of silently overwriting a
     * change made elsewhere.
     * @param props - slot props: `t`, `close`, and the `ctx` this module adds.
     */
    function MemoryVaultSection(props) {
      const { ctx, t } = props
      const form = React.useMemo(() => ctx.configForms.get(NS), [ctx])
      const subscribe = React.useCallback((listener) => form.subscribe(listener), [form])
      const readSnapshot = React.useCallback(() => form.getSnapshot(), [form])
      const snapshot = React.useSyncExternalStore(subscribe, readSnapshot)
      const value = snapshot.value

      const savedVault = value !== undefined && typeof value.vault === 'string' ? value.vault : ''
      const savedEnabled = value === undefined || value.syncEnabled === undefined ? true : value.syncEnabled !== false
      const savedInterval = value !== undefined && typeof value.syncIntervalSeconds === 'number'
        ? value.syncIntervalSeconds
        : DEFAULT_SYNC_INTERVAL_SECONDS

      const [draft, setDraft] = React.useState(savedVault)
      const [enabled, setEnabled] = React.useState(savedEnabled)
      // The interval is edited as text so a half-typed number is not coerced to 0.
      const [interval, setInterval] = React.useState(String(savedInterval))
      const [phase, setPhase] = React.useState('idle')

      // Follow the Host whenever a stored value changes: another window, a refused
      // write, or the first describe arriving after mount.
      React.useEffect(() => {
        setDraft(savedVault)
        setEnabled(savedEnabled)
        setInterval(String(savedInterval))
      }, [savedVault, savedEnabled, savedInterval])

      const parsedInterval = Number.parseInt(interval, 10)
      const intervalValid = Number.isFinite(parsedInterval) && parsedInterval >= 60
      const dirty = draft !== savedVault
        || enabled !== savedEnabled
        || (intervalValid && parsedInterval !== savedInterval)
      const canSave = dirty && phase !== 'saving' && snapshot.writable && (intervalValid || !enabled)

      const save = () => {
        if (!canSave) return
        setPhase('saving')
        const writes = [
          ['vault', draft.trim()],
          ['syncEnabled', enabled],
          ['syncIntervalSeconds', intervalValid ? parsedInterval : savedInterval],
        ]
        // Sequential: each `set` carries the revision from the previous result, so
        // firing them together would race the fence and drop all but the first.
        writes.reduce(
          (chain, [field, fieldValue]) => chain.then((stillOk) => {
            if (!stillOk) return false
            return form.set(field, fieldValue).then((accepted) => accepted !== false, () => false)
          }),
          Promise.resolve(true),
        ).then((ok) => {
          setPhase(ok ? 'saved' : 'failed')
        }, () => setPhase('failed'))
      }

      if (snapshot.status === 'unavailable' && value === undefined) {
        return h('div', { className: 'dmv-root' }, h('p', { className: 'dmv-hint' }, t('empty.unavailable')))
      }

      const statusText = savedVault.length === 0 ? t('status.unset') : t('status.saved')
      const notes = []
      if (phase === 'saved' && !dirty) notes.push(h('span', { key: 'saved', className: 'dmv-hint' }, t('action.saved')))
      if (phase === 'failed') notes.push(h('span', { key: 'failed', className: 'dmv-error' }, t('action.failed')))
      if (!intervalValid && enabled) notes.push(h('span', { key: 'badInterval', className: 'dmv-error' }, t('field.intervalInvalid')))

      return h('div', { className: 'dmv-root' }, [
        h('style', { key: 'style', dangerouslySetInnerHTML: { __html: STYLE } }),
        h('h2', { key: 'title', className: 'dmv-title' }, t('section.title')),
        h('p', { key: 'subtitle', className: 'dmv-subtitle' }, t('section.subtitle')),

        h('label', { key: 'label', className: 'dmv-label', htmlFor: 'dmv-vault' }, t('field.vault')),
        h(Input, {
          key: 'input',
          id: 'dmv-vault',
          value: draft,
          placeholder: 'D:\\notes\\MemoryVault',
          onChange: (event) => {
            setDraft(event.target.value)
            setPhase('idle')
          },
        }),
        h('p', { key: 'hint', className: 'dmv-hint' }, t('field.vaultHint')),

        h('h3', { key: 'syncTitle', className: 'dmv-title' }, t('section.sync')),
        h('label', { key: 'enabledLabel', className: 'dmv-check' }, [
          h('input', {
            key: 'enabled',
            type: 'checkbox',
            checked: enabled,
            onChange: (event) => {
              setEnabled(event.target.checked)
              setPhase('idle')
            },
          }),
          h('span', { key: 'text' }, t('field.syncEnabled')),
        ]),
        h('p', { key: 'enabledHint', className: 'dmv-hint' }, t('field.syncEnabledHint')),

        h('label', { key: 'intervalLabel', className: 'dmv-label', htmlFor: 'dmv-interval' }, t('field.syncInterval')),
        h(Input, {
          key: 'interval',
          id: 'dmv-interval',
          type: 'number',
          min: '60',
          step: '30',
          value: interval,
          disabled: !enabled,
          onChange: (event) => {
            setInterval(event.target.value)
            setPhase('idle')
          },
        }),
        h('p', { key: 'intervalHint', className: 'dmv-hint' }, t('field.syncIntervalHint')),

        h('div', { key: 'row', className: 'dmv-row' }, [
          h(Button, { key: 'save', disabled: !canSave, onClick: save },
            phase === 'saving' ? t('action.saving') : t('action.save')),
          h(Tag, { key: 'status', tone: 'neutral' }, statusText),
          ...notes,
        ]),
      ])
    }

    /** Client plugin body: the settings page, and nothing else. */
    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), 'dsh-memory-vault: dictionaries')

      // `ctx` reaches the component through the closure: a section's owner props
      // carry only `close`.
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: NS,
        order: 80,
        label: () => t('section.title'),
        locale: NS,
      }, (ownerProps) => h(MemoryVaultSection, Object.assign({}, ownerProps, { ctx }))))
    }

    return {
      inject: ['slots', 'locale', 'configForms'],
      apply,
    }
  },
})
