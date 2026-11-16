import { InstanceBase, InstanceStatus, Regex, combineRgb, runEntrypoint } from '@companion-module/base'
import WebSocket from 'ws'

const WHITE = combineRgb(255, 255, 255)
const BLACK = combineRgb(0, 0, 0)
const RED = combineRgb(220, 38, 38)
const YELLOW = combineRgb(245, 180, 0)
const GREEN = combineRgb(25, 194, 107)
const DARK = combineRgb(30, 34, 43)
const DARK_RED = combineRgb(90, 20, 20)

// 5:00 counts down until a full second has passed; over time shows +0:12.
function formatTimer(ms) {
	const over = ms < 0
	const total = over ? Math.floor(-ms / 1000) : Math.ceil(ms / 1000)
	const h = Math.floor(total / 3600)
	const m = Math.floor((total % 3600) / 60)
	const sec = String(total % 60).padStart(2, '0')
	return `${over ? '+' : ''}${h ? `${h}:${String(m).padStart(2, '0')}` : String(m).padStart(2, '0')}:${sec}`
}

function hexToRgb(hex) {
	const m = /^#?([0-9a-f]{6})$/i.exec(hex || '')
	if (!m) return null
	const n = parseInt(m[1], 16)
	return combineRgb((n >> 16) & 255, (n >> 8) & 255, n & 255)
}

class DeckCueInstance extends InstanceBase {
	async init(config) {
		this.config = config
		this.state = null
		this.cueSignature = null
		this.ws = null
		this.reconnectTimer = null
		this.clockOffset = 0
		this.timerText = null
		this.buildDefinitions()
		this.connect()
		// The timer counts locally between state updates, so it stays smooth without network traffic.
		this.tickInterval = setInterval(() => this.tickTimer(), 250)
	}

	async destroy() {
		clearInterval(this.tickInterval)
		this.disconnect()
	}

	async configUpdated(config) {
		this.config = config
		this.disconnect()
		this.connect()
	}

	getConfigFields() {
		return [
			{
				type: 'static-text',
				id: 'info',
				width: 12,
				label: 'Setup',
				value:
					'In needit Deck Cue open ⚙︎ Settings › Remote control. If Companion runs on another computer, tick "Allow other computers on the network" and use the address it shows.',
			},
			{ type: 'textinput', id: 'host', label: 'Deck Cue computer (IP or hostname)', width: 8, default: '127.0.0.1', regex: Regex.HOSTNAME },
			{ type: 'number', id: 'port', label: 'Port', width: 4, default: 9640, min: 1, max: 65535 },
		]
	}

	// ---------- connection ----------
	connect() {
		const { host, port } = this.config
		if (!host || !port) {
			this.updateStatus(InstanceStatus.BadConfig, 'Set the host and port')
			return
		}
		this.updateStatus(InstanceStatus.Connecting)
		const ws = new WebSocket(`ws://${host}:${port}/api/ws`, { handshakeTimeout: 4000 })
		this.ws = ws
		ws.on('open', () => this.updateStatus(InstanceStatus.Ok))
		ws.on('message', (data) => {
			try {
				const msg = JSON.parse(data.toString())
				if (msg.type === 'state') this.applyState(msg.state)
			} catch (e) {
				this.log('debug', `Bad message: ${e.message}`)
			}
		})
		ws.on('error', (e) => this.updateStatus(InstanceStatus.ConnectionFailure, e.message))
		ws.on('close', () => {
			if (this.ws !== ws) return
			this.ws = null
			this.updateStatus(InstanceStatus.Disconnected, 'Waiting for Deck Cue')
			this.reconnectTimer = setTimeout(() => this.connect(), 2000)
		})
	}

	disconnect() {
		clearTimeout(this.reconnectTimer)
		const ws = this.ws
		this.ws = null
		if (ws) {
			ws.removeAllListeners()
			ws.on('error', () => {})
			ws.terminate()
		}
	}

	async post(path) {
		try {
			const res = await fetch(`http://${this.config.host}:${this.config.port}${path}`, { method: 'POST' })
			if (!res.ok) {
				const body = await res.json().catch(() => ({}))
				this.log('warn', `${path}: ${body.error || res.status}`)
			}
		} catch (e) {
			this.log('error', `${path}: ${e.message}`)
		}
	}

	// ---------- state ----------
	timerRemaining() {
		const t = this.state && this.state.timer
		if (!t) return 0
		return t.running ? t.endsAt - (Date.now() + this.clockOffset) : t.remaining
	}

	timerIdle() {
		const t = this.state && this.state.timer
		return !t || (!t.running && !t.duration && !t.remaining)
	}

	tickTimer() {
		if (!this.state) return
		const text = this.timerIdle() ? '--:--' : formatTimer(this.timerRemaining())
		if (text === this.timerText) return
		this.timerText = text
		this.setVariableValues({ timer: text, timer_seconds: Math.round(this.timerRemaining() / 1000) })
		this.checkFeedbacks('timer_warning', 'timer_overtime')
	}

	applyState(state) {
		this.state = state
		if (state.now) this.clockOffset = state.now - Date.now()
		// Rebuild dropdowns, variables and presets only when the cue list itself changes.
		const signature = JSON.stringify(state.cues.map((c) => [c.number, c.id, c.name]))
		if (signature !== this.cueSignature) {
			this.cueSignature = signature
			this.buildDefinitions()
		}
		const live = state.live
		const values = {
			show_name: state.show || '',
			role: state.role || 'standalone',
			show_mode: state.showMode ? 'ON' : 'OFF',
			timer_screen: !state.timerScreen || state.timerScreen.mode === 'off' ? 'off' : state.timerScreen.mode === 'pip' ? 'overlay' : state.timerScreen.content === 'clock' ? 'clock' : 'full',
			presenter: !state.presenter || !state.presenter.enabled ? 'OFF' : state.presenter.muted ? 'PAUSED' : 'ON',
			live_number: live ? live.number : '',
			live_name: live ? live.name : '',
			next_number: state.next ? state.next.number : '',
			next_name: state.next ? state.next.name : '',
			slide: live && live.slide ? live.slide : '',
			slides: live && live.slides ? live.slides : '',
			slide_text: live && live.slide ? `${live.slide}/${live.slides}` : '',
			blackout: state.blackout ? 'ON' : 'OFF',
			timer_state: !state.timer ? '' : state.timer.running ? 'running' : this.timerIdle() ? 'idle' : 'paused',
			stage_message: state.stageMessage ? state.stageMessage.text : '',
			cue_count: state.cues.length,
			preflight: (() => {
				const errors = state.cues.filter((c) => c.preflight === 'error').length
				const warns = state.cues.filter((c) => c.preflight === 'warn').length
				return errors ? `${errors} won't play` : warns ? `${warns} to check` : state.cues.length ? 'Ready' : ''
			})(),
		}
		for (const c of state.cues) values[`cue_${c.number}_name`] = c.name
		this.setVariableValues(values)
		this.timerText = null
		this.tickTimer()
		this.checkFeedbacks()
	}

	cueMatches(cue, ref) {
		const v = String(ref ?? '').trim()
		return String(cue.number) === v || cue.id === v || cue.name.toLowerCase() === v.toLowerCase()
	}

	findCue(ref) {
		return this.state ? this.state.cues.find((c) => this.cueMatches(c, ref)) : undefined
	}

	// ---------- definitions ----------
	buildDefinitions() {
		const cues = this.state ? this.state.cues : []
		const choices = cues.map((c) => ({ id: String(c.number), label: `${c.number}. ${c.name}` }))
		const cueOption = {
			type: 'dropdown',
			id: 'cue',
			label: 'Cue (pick, or type a number or name)',
			default: choices[0] ? choices[0].id : '1',
			choices,
			allowCustom: true,
		}
		const ref = (o) => encodeURIComponent(String(o.cue).trim())

		this.setActionDefinitions({
			go: { name: 'GO (fire next cue)', options: [], callback: () => this.post('/api/go') },
			stop: { name: 'Stop all', options: [], callback: () => this.post('/api/stop') },
			next_slide: { name: 'Next slide', options: [], callback: () => this.post('/api/next') },
			prev_slide: { name: 'Previous slide', options: [], callback: () => this.post('/api/prev') },
			blackout: {
				name: 'Blackout',
				options: [
					{
						type: 'dropdown',
						id: 'mode',
						label: 'Mode',
						default: 'toggle',
						choices: [
							{ id: 'toggle', label: 'Toggle' },
							{ id: 'on', label: 'On' },
							{ id: 'off', label: 'Off' },
						],
					},
				],
				callback: (a) => this.post(a.options.mode === 'toggle' ? '/api/blackout' : `/api/blackout?state=${a.options.mode}`),
			},
			fire_cue: { name: 'Fire cue', options: [cueOption], callback: (a) => this.post(`/api/cue/${ref(a.options)}/fire`) },
			arm_cue: { name: 'Arm cue (set as next)', options: [cueOption], callback: (a) => this.post(`/api/cue/${ref(a.options)}/arm`) },
			arm_next: { name: 'Arm next cue', options: [], callback: () => this.post('/api/arm/next') },
			arm_prev: { name: 'Arm previous cue', options: [], callback: () => this.post('/api/arm/prev') },
			timer_start: { name: 'Timer: start', options: [], callback: () => this.post('/api/timer/start') },
			timer_pause: { name: 'Timer: pause', options: [], callback: () => this.post('/api/timer/pause') },
			timer_toggle: {
				name: 'Timer: start/pause',
				options: [],
				callback: () => this.post(this.state && this.state.timer && this.state.timer.running ? '/api/timer/pause' : '/api/timer/start'),
			},
			timer_reset: { name: 'Timer: reset', options: [], callback: () => this.post('/api/timer/reset') },
			timer_set: {
				name: 'Timer: set',
				options: [
					{ type: 'number', id: 'minutes', label: 'Minutes', default: 5, min: 0, max: 600, step: 0.5 },
					{ type: 'checkbox', id: 'start', label: 'Start it', default: false },
				],
				callback: async (a) => {
					await this.post(`/api/timer/set?seconds=${Math.round(Number(a.options.minutes) * 60)}`)
					if (a.options.start) await this.post('/api/timer/start')
				},
			},
			timer_add: {
				name: 'Timer: add or remove time',
				options: [{ type: 'number', id: 'minutes', label: 'Minutes (negative removes)', default: 1, min: -600, max: 600, step: 0.5 }],
				callback: (a) => this.post(`/api/timer/add?seconds=${Math.round(Number(a.options.minutes) * 60)}`),
			},
			message_send: {
				name: 'Stage message: show',
				options: [
					{ type: 'textinput', id: 'text', label: 'Message', default: 'WRAP UP', useVariables: true },
					{ type: 'checkbox', id: 'flash', label: 'Flash', default: false },
				],
				callback: async (a, context) => {
					const text = await context.parseVariablesInString(a.options.text)
					await this.post(`/api/message?text=${encodeURIComponent(text)}&flash=${a.options.flash ? 1 : 0}`)
				},
			},
			message_clear: { name: 'Stage message: clear', options: [], callback: () => this.post('/api/message/clear') },
			timer_screen: {
				name: 'Timer: full screen on the output',
				options: [
					{
						type: 'dropdown',
						id: 'mode',
						label: 'Mode',
						default: 'toggle',
						choices: [
							{ id: 'toggle', label: 'Toggle' },
							{ id: 'on', label: 'Show' },
							{ id: 'off', label: 'Hide' },
						],
					},
				],
				callback: (a) => this.post(a.options.mode === 'toggle' ? '/api/timerscreen' : `/api/timerscreen?state=${a.options.mode}`),
			},
			presenter_mute: {
				name: 'Presenter remote: pause / allow',
				options: [
					{
						type: 'dropdown',
						id: 'mode',
						label: 'Mode',
						default: 'toggle',
						choices: [
							{ id: 'toggle', label: 'Toggle' },
							{ id: 'on', label: 'Pause' },
							{ id: 'off', label: 'Allow' },
						],
					},
				],
				callback: (a) => this.post(a.options.mode === 'toggle' ? '/api/presenter/mute' : `/api/presenter/mute?state=${a.options.mode}`),
			},
			show_mode: {
				name: 'Show-machine mode',
				options: [
					{
						type: 'dropdown',
						id: 'mode',
						label: 'Mode',
						default: 'toggle',
						choices: [
							{ id: 'toggle', label: 'Toggle' },
							{ id: 'on', label: 'On' },
							{ id: 'off', label: 'Off' },
						],
					},
				],
				callback: (a) => this.post(a.options.mode === 'toggle' ? '/api/showmode' : `/api/showmode?state=${a.options.mode}`),
			},
		})

		const cueState = (o, wanted) => {
			const c = this.findCue(o.cue)
			return !!c && c.state === wanted
		}
		this.setFeedbackDefinitions({
			cue_live: {
				type: 'boolean',
				name: 'Cue is live',
				defaultStyle: { bgcolor: RED, color: WHITE },
				options: [cueOption],
				callback: (f) => cueState(f.options, 'live'),
			},
			cue_next: {
				type: 'boolean',
				name: 'Cue is next (armed)',
				defaultStyle: { bgcolor: YELLOW, color: BLACK },
				options: [cueOption],
				callback: (f) => cueState(f.options, 'next'),
			},
			cue_loading: {
				type: 'boolean',
				name: 'Cue is loading',
				defaultStyle: { bgcolor: combineRgb(76, 141, 255), color: WHITE },
				options: [cueOption],
				callback: (f) => cueState(f.options, 'loading'),
			},
			cue_missing: {
				type: 'boolean',
				name: 'Cue file missing',
				defaultStyle: { bgcolor: DARK_RED, color: combineRgb(255, 157, 157) },
				options: [cueOption],
				callback: (f) => {
					const c = this.findCue(f.options.cue)
					return !!c && c.missing
				},
			},
			blackout: {
				type: 'boolean',
				name: 'Blackout is on',
				defaultStyle: { bgcolor: WHITE, color: BLACK },
				options: [],
				callback: () => !!(this.state && this.state.blackout),
			},
			something_live: {
				type: 'boolean',
				name: 'Something is live',
				defaultStyle: { bgcolor: RED, color: WHITE },
				options: [],
				callback: () => !!(this.state && this.state.live),
			},
			timer_running: {
				type: 'boolean',
				name: 'Timer is running',
				defaultStyle: { bgcolor: GREEN, color: BLACK },
				options: [],
				callback: () => !!(this.state && this.state.timer && this.state.timer.running),
			},
			timer_warning: {
				type: 'boolean',
				name: 'Timer is nearly done',
				defaultStyle: { bgcolor: YELLOW, color: BLACK },
				options: [{ type: 'number', id: 'seconds', label: 'When this many seconds or fewer are left', default: 120, min: 1, max: 3600 }],
				callback: (f) => {
					if (this.timerIdle()) return false
					const left = this.timerRemaining()
					return left >= 0 && left <= Number(f.options.seconds) * 1000
				},
			},
			timer_overtime: {
				type: 'boolean',
				name: 'Timer is over time',
				defaultStyle: { bgcolor: RED, color: WHITE },
				options: [],
				callback: () => !this.timerIdle() && this.timerRemaining() < 0,
			},
			timer_screen_full: {
				type: 'boolean',
				name: 'Timer or clock is full screen on the output',
				defaultStyle: { bgcolor: YELLOW, color: BLACK },
				options: [],
				callback: () => !!(this.state && this.state.timerScreen && this.state.timerScreen.mode === 'full'),
			},
			presenter_paused: {
				type: 'boolean',
				name: 'Presenter remote is paused',
				defaultStyle: { bgcolor: YELLOW, color: BLACK },
				options: [],
				callback: () => !!(this.state && this.state.presenter && this.state.presenter.enabled && this.state.presenter.muted),
			},
			cue_updated: {
				type: 'boolean',
				name: 'Cue file changed on disk',
				defaultStyle: { bgcolor: combineRgb(31, 79, 168), color: WHITE },
				options: [cueOption],
				callback: (f) => {
					const c = this.findCue(f.options.cue)
					return !!c && !!c.changed
				},
			},
			cue_newer: {
				type: 'boolean',
				name: 'Newer version of the cue file available',
				defaultStyle: { bgcolor: YELLOW, color: BLACK },
				options: [cueOption],
				callback: (f) => {
					const c = this.findCue(f.options.cue)
					return !!c && !!c.newer
				},
			},
			show_mode: {
				type: 'boolean',
				name: 'Show mode is on',
				defaultStyle: { bgcolor: YELLOW, color: BLACK },
				options: [],
				callback: () => !!(this.state && this.state.showMode),
			},
			message_showing: {
				type: 'boolean',
				name: 'Stage message is showing',
				defaultStyle: { bgcolor: WHITE, color: BLACK },
				options: [],
				callback: () => !!(this.state && this.state.stageMessage && this.state.stageMessage.text),
			},
			cue_preflight: {
				type: 'boolean',
				name: 'Cue has preflight problems',
				defaultStyle: { bgcolor: combineRgb(122, 23, 23), color: WHITE },
				options: [
					cueOption,
					{
						type: 'dropdown',
						id: 'level',
						label: 'When',
						default: 'error',
						choices: [
							{ id: 'error', label: "It won't play (error)" },
							{ id: 'warn', label: 'Anything to check (warning or error)' },
						],
					},
				],
				callback: (f) => {
					const c = this.findCue(f.options.cue)
					if (!c) return false
					return f.options.level === 'warn' ? c.preflight === 'warn' || c.preflight === 'error' : c.preflight === 'error'
				},
			},
			show_preflight: {
				type: 'boolean',
				name: 'Show has preflight problems',
				defaultStyle: { bgcolor: combineRgb(122, 23, 23), color: WHITE },
				options: [
					{
						type: 'dropdown',
						id: 'level',
						label: 'When',
						default: 'error',
						choices: [
							{ id: 'error', label: "A cue won't play (error)" },
							{ id: 'warn', label: 'Anything to check (warning or error)' },
						],
					},
				],
				callback: (f) =>
					!!this.state &&
					this.state.cues.some((c) => c.preflight === 'error' || (f.options.level === 'warn' && c.preflight === 'warn')),
			},
			cue_color: {
				type: 'advanced',
				name: 'Cue colour (from Deck Cue)',
				options: [cueOption],
				callback: (f) => {
					const c = this.findCue(f.options.cue)
					const rgb = c && hexToRgb(c.color)
					return rgb === null || !c ? {} : { bgcolor: rgb, color: WHITE }
				},
			},
		})

		const variables = [
			{ variableId: 'show_name', name: 'Show name' },
			{ variableId: 'role', name: 'Role of this Deck Cue (standalone/main/backup)' },
			{ variableId: 'show_mode', name: 'Show-machine mode (ON/OFF)' },
			{ variableId: 'timer_screen', name: 'Timer on the output (off/overlay/full/clock)' },
			{ variableId: 'presenter', name: 'Presenter remote (ON/PAUSED/OFF)' },
			{ variableId: 'live_number', name: 'Live cue number' },
			{ variableId: 'live_name', name: 'Live cue name' },
			{ variableId: 'next_number', name: 'Next cue number' },
			{ variableId: 'next_name', name: 'Next cue name' },
			{ variableId: 'slide', name: 'Current slide/page (PDF cues)' },
			{ variableId: 'slides', name: 'Total slides/pages (PDF cues)' },
			{ variableId: 'slide_text', name: 'Slide as text, e.g. 3/12' },
			{ variableId: 'blackout', name: 'Blackout (ON/OFF)' },
			{ variableId: 'cue_count', name: 'Number of cues' },
			{ variableId: 'preflight', name: "Preflight summary (Ready / 2 to check / 1 won't play)" },
			{ variableId: 'timer', name: 'Speaker timer (e.g. 04:59, +00:12 when over)' },
			{ variableId: 'timer_seconds', name: 'Speaker timer in seconds (negative when over)' },
			{ variableId: 'timer_state', name: 'Timer state (running/paused/idle)' },
			{ variableId: 'stage_message', name: 'Stage message' },
			...cues.map((c) => ({ variableId: `cue_${c.number}_name`, name: `Cue ${c.number} name` })),
		]
		this.setVariableDefinitions(variables)
		this.setPresetDefinitions(this.buildPresets(cues))
	}

	buildPresets(cues) {
		const v = (id) => `$(${this.label}:${id})`
		const button = (category, name, text, actionId, options, style, feedbacks = []) => ({
			type: 'button',
			category,
			name,
			style: { text, size: 'auto', color: WHITE, bgcolor: DARK, ...style },
			steps: [{ down: [{ actionId, options }], up: [] }],
			feedbacks,
		})
		const presets = {
			go: button('Transport', 'GO (next cue)', `GO\\n${v('next_name')}`, 'go', {}, { bgcolor: GREEN, color: BLACK }),
			stop: button('Transport', 'Stop all', 'STOP', 'stop', {}, { bgcolor: DARK_RED }),
			blackout: button('Transport', 'Blackout toggle', 'BLACK\\nOUT', 'blackout', { mode: 'toggle' }, { bgcolor: BLACK }, [
				{ feedbackId: 'blackout', options: {}, style: { bgcolor: WHITE, color: BLACK } },
			]),
			next_slide: button('Transport', 'Next slide', `SLIDE ▶\\n${v('slide_text')}`, 'next_slide', {}, {}),
			prev_slide: button('Transport', 'Previous slide', '◀ SLIDE', 'prev_slide', {}, {}),
			arm_next: button('Transport', 'Arm next cue', 'NEXT ▼', 'arm_next', {}, {}),
			arm_prev: button('Transport', 'Arm previous cue', 'NEXT ▲', 'arm_prev', {}, {}),
			live_display: button('Transport', 'Live cue display', `LIVE\\n${v('live_number')} ${v('live_name')}`, 'stop', {}, {}, [
				{ feedbackId: 'something_live', options: {}, style: { bgcolor: RED, color: WHITE } },
			]),
		}
		presets.preflight = button('Transport', 'Preflight status', `PRE\\nFLIGHT\\n${v('preflight')}`, 'go', {}, { bgcolor: combineRgb(15, 46, 29), size: '14' }, [
			{ feedbackId: 'show_preflight', options: { level: 'warn' }, style: { bgcolor: YELLOW, color: BLACK } },
			{ feedbackId: 'show_preflight', options: { level: 'error' }, style: { bgcolor: RED, color: WHITE } },
		])
		presets.preflight.steps = [{ down: [], up: [] }]
		presets.presenter = button('Transport', 'Presenter remote pause/allow', `PRESENTER\\n${v('presenter')}`, 'presenter_mute', { mode: 'toggle' }, { size: '14' }, [
			{ feedbackId: 'presenter_paused', options: {}, style: { bgcolor: YELLOW, color: BLACK } },
		])
		presets.show_mode = button('Transport', 'Show mode toggle', 'SHOW\\nMODE', 'show_mode', { mode: 'toggle' }, {}, [
			{ feedbackId: 'show_mode', options: {}, style: { bgcolor: YELLOW, color: BLACK } },
		])
		// The live display preset shouldn't stop the show when pressed.
		presets.live_display.steps = [{ down: [], up: [] }]

		presets.timer_display = button('Timer', 'Timer (start/pause)', v('timer'), 'timer_toggle', {}, { size: '24' }, [
			{ feedbackId: 'timer_running', options: {}, style: { bgcolor: combineRgb(10, 60, 30), color: WHITE } },
			{ feedbackId: 'timer_warning', options: { seconds: 120 }, style: { bgcolor: YELLOW, color: BLACK } },
			{ feedbackId: 'timer_overtime', options: {}, style: { bgcolor: RED, color: WHITE } },
		])
		presets.timer_screen = button('Timer', 'Timer full screen', 'TIMER\\nFULL\\nSCREEN', 'timer_screen', { mode: 'toggle' }, { size: '14' }, [
			{ feedbackId: 'timer_screen_full', options: {}, style: { bgcolor: YELLOW, color: BLACK } },
		])
		presets.timer_reset = button('Timer', 'Timer reset', 'TIMER\\nRESET', 'timer_reset', {}, {})
		for (const min of [5, 10, 15, 20, 30]) {
			presets[`timer_set_${min}`] = button('Timer', `Set ${min} min`, `${min} MIN`, 'timer_set', { minutes: min, start: false }, {})
		}
		presets.timer_add_1 = button('Timer', 'Add 1 minute', '+1 MIN', 'timer_add', { minutes: 1 }, {})
		presets.timer_sub_1 = button('Timer', 'Remove 1 minute', '−1 MIN', 'timer_add', { minutes: -1 }, {})
		for (const [id, text, flash] of [['wrap', 'WRAP UP', true], ['five', '5 MIN', false], ['one', '1 MIN', true], ['louder', 'LOUDER', false], ['mic', 'CHECK MIC', true]]) {
			presets[`msg_${id}`] = button('Stage messages', `Message: ${text}`, text, 'message_send', { text, flash }, {}, [
				{ feedbackId: 'message_showing', options: {}, style: { bgcolor: WHITE, color: BLACK } },
			])
		}
		presets.msg_clear = button('Stage messages', 'Clear message', 'CLEAR\\nMSG', 'message_clear', {}, { bgcolor: DARK_RED })

		for (const c of cues) {
			const options = { cue: String(c.number) }
			presets[`cue_${c.number}`] = button('Cues', `Cue ${c.number}`, `${c.number}\\n${v(`cue_${c.number}_name`)}`, 'fire_cue', options, {}, [
				{ feedbackId: 'cue_color', options },
				{ feedbackId: 'cue_missing', options, style: { bgcolor: DARK_RED, color: combineRgb(255, 157, 157) } },
				{ feedbackId: 'cue_preflight', options: { ...options, level: 'error' }, style: { bgcolor: DARK_RED, color: combineRgb(255, 157, 157) } },
				{ feedbackId: 'cue_next', options, style: { bgcolor: YELLOW, color: BLACK } },
				{ feedbackId: 'cue_live', options, style: { bgcolor: RED, color: WHITE } },
			])
		}
		return presets
	}
}

runEntrypoint(DeckCueInstance, [])
