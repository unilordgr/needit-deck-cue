import { InstanceBase, InstanceStatus, Regex, combineRgb, runEntrypoint } from '@companion-module/base'
import WebSocket from 'ws'

const WHITE = combineRgb(255, 255, 255)
const BLACK = combineRgb(0, 0, 0)
const RED = combineRgb(220, 38, 38)
const YELLOW = combineRgb(245, 180, 0)
const GREEN = combineRgb(25, 194, 107)
const DARK = combineRgb(30, 34, 43)
const DARK_RED = combineRgb(90, 20, 20)

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
		this.buildDefinitions()
		this.connect()
	}

	async destroy() {
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
	applyState(state) {
		this.state = state
		// Rebuild dropdowns, variables and presets only when the cue list itself changes.
		const signature = JSON.stringify(state.cues.map((c) => [c.number, c.id, c.name]))
		if (signature !== this.cueSignature) {
			this.cueSignature = signature
			this.buildDefinitions()
		}
		const live = state.live
		const values = {
			show_name: state.show || '',
			live_number: live ? live.number : '',
			live_name: live ? live.name : '',
			next_number: state.next ? state.next.number : '',
			next_name: state.next ? state.next.name : '',
			slide: live && live.slide ? live.slide : '',
			slides: live && live.slides ? live.slides : '',
			slide_text: live && live.slide ? `${live.slide}/${live.slides}` : '',
			blackout: state.blackout ? 'ON' : 'OFF',
			cue_count: state.cues.length,
		}
		for (const c of state.cues) values[`cue_${c.number}_name`] = c.name
		this.setVariableValues(values)
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
			{ variableId: 'live_number', name: 'Live cue number' },
			{ variableId: 'live_name', name: 'Live cue name' },
			{ variableId: 'next_number', name: 'Next cue number' },
			{ variableId: 'next_name', name: 'Next cue name' },
			{ variableId: 'slide', name: 'Current slide/page (PDF cues)' },
			{ variableId: 'slides', name: 'Total slides/pages (PDF cues)' },
			{ variableId: 'slide_text', name: 'Slide as text, e.g. 3/12' },
			{ variableId: 'blackout', name: 'Blackout (ON/OFF)' },
			{ variableId: 'cue_count', name: 'Number of cues' },
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
		// The live display preset shouldn't stop the show when pressed.
		presets.live_display.steps = [{ down: [], up: [] }]

		for (const c of cues) {
			const options = { cue: String(c.number) }
			presets[`cue_${c.number}`] = button('Cues', `Cue ${c.number}`, `${c.number}\\n${v(`cue_${c.number}_name`)}`, 'fire_cue', options, {}, [
				{ feedbackId: 'cue_color', options },
				{ feedbackId: 'cue_missing', options, style: { bgcolor: DARK_RED, color: combineRgb(255, 157, 157) } },
				{ feedbackId: 'cue_next', options, style: { bgcolor: YELLOW, color: BLACK } },
				{ feedbackId: 'cue_live', options, style: { bgcolor: RED, color: WHITE } },
			])
		}
		return presets
	}
}

runEntrypoint(DeckCueInstance, [])
