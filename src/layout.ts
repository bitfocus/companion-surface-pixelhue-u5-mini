import type { OpenDeviceResult } from './types.js'
import { BUTTON_SIZE, GRID_COLS, GRID_ROWS } from './constants.js'

/**
 * Build the default surface layout:
 * map each key to (column, row) coordinates and set the default bitmap size.
 */
export function buildSurfaceLayout(): OpenDeviceResult['surfaceLayout'] {
	const controls: Record<string, { column: number; row: number }> = {}

	for (let row = 0; row < GRID_ROWS; row++) {
		for (let col = 0; col < GRID_COLS; col++) {
			controls[`${col}_${row}`] = { column: col, row }
		}
	}

	return {
		controls,
		stylePresets: {
			default: {
				bitmap: { format: 'rgba', w: BUTTON_SIZE, h: BUTTON_SIZE },
			},
		},
	}
}

export const DEFAULT_SURFACE_LAYOUT = buildSurfaceLayout()
