import type { SomeCompanionInputField } from '@companion-surface/base'

/** Dedup expression for discovery list "Already added": same address + port = same connection */
export const remoteCheckConfigMatchesExpression = '$(objA:address) === $(objB:address) && $(objA:port) == $(objB:port)'
export const GRID_COLS = 10
export const GRID_ROWS = 4

export const DEFAULT_TCP_PORT = 17100
export const BUTTON_SIZE = 72

/** Max draw queue length to avoid memory pressure and lag under bursty updates */
export const MAX_DRAW_QUEUE_LENGTH = 50

/** Poll interval while the draw queue waits for a ready socket */
export const CONNECTED_POLL_DELAY_MS = 300

/** Max time to wait for socket readiness before dropping queued draw frames */
export const CONNECT_WAIT_TIMEOUT_MS = 15000

export const BUTTON_WIDTH = 72
export const BUTTON_HEIGHT = 72
export const PIXELHUE_U5_MINI_NAME = 'Pixelhue U5 Mini'

// IPv4 dotted-quad validation, range-limited to avoid passing invalid strings to connectTo()
export const IPV4_REGEX = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/

/** Outbound connection config fields */
export const remoteConfigFields: SomeCompanionInputField[] = [
	{
		type: 'textinput',
		id: 'address',
		label: 'IP Address',
		default: '',
	},
	{
		type: 'number',
		id: 'port',
		label: 'Port',
		default: DEFAULT_TCP_PORT,
		min: 1,
		max: 65535,
		step: 1,
	},
]
