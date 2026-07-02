import type {
	CardGenerator,
	OpenSurfaceResult,
	SurfaceContext,
	SurfaceDrawProps,
	SurfacePlugin,
} from '@companion-surface/base'
import { PixelhueSurfaceModule } from './surface-module.js'
import { DEFAULT_SURFACE_LAYOUT } from './layout.js'
import type { HostContext, OpenDeviceResult } from './types.js'
import { PixelhueRemote, type PixelhueRemoteDeviceInfo } from './remote.js'
import { PIXELHUE_U5_MINI_NAME } from './constants.js'

const surfaceContexts = new Map<string, SurfaceContext>()
let moduleInstance: PixelhueSurfaceModule | null = null

const remote = new PixelhueRemote(() => moduleInstance)

function emitSurfaceConnected(info: OpenDeviceResult): void {
	remote.emit('surfacesConnected', [
		{
			surfaceId: info.surfaceId,
			deviceHandle: info.surfaceId,
			description: info.description,
			pluginInfo: { type: 'remote' } satisfies PixelhueRemoteDeviceInfo,
		},
	])
}

function disconnectContext(surfaceId: string): void {
	const ctx = surfaceContexts.get(surfaceId)
	ctx?.disconnect(new Error('Disconnected'))
	surfaceContexts.delete(surfaceId)
}

const plugin: SurfacePlugin<PixelhueRemoteDeviceInfo> = {
	remote,
	/**
	 * SurfacePlugin init: create moduleInstance and inject host context (discovery bridge and input events).
	 */
	async init(): Promise<void> {
		if (moduleInstance) return

		const hostContext: HostContext = {
			connectionsFound: (infos) => {
				remote.emit('connectionsFound', infos)
			},
			connectionsForgotten: (connectionIds) => {
				remote.emit('connectionsForgotten', connectionIds)
			},
			notifyOpenedDiscoveredSurface: async (info: OpenDeviceResult) => {
				emitSurfaceConnected(info)
			},
			surfaceEvents: {
				inputPress: (surfaceId, controlId, pressed) => {
					const ctx = surfaceContexts.get(surfaceId)
					if (!ctx) return
					if (pressed) ctx.keyDownById(controlId)
					else ctx.keyUpById(controlId)
				},
				inputRotate: (surfaceId, controlId, delta) => {
					const ctx = surfaceContexts.get(surfaceId)
					if (!ctx) return
					if (delta >= 0) ctx.rotateRightById(controlId)
					else ctx.rotateLeftById(controlId)
				},
			},
			disconnected: (surfaceId) => {
				disconnectContext(surfaceId)
			},
		}

		moduleInstance = new PixelhueSurfaceModule(hostContext)
		await moduleInstance.init()
	},
	/**
	 * SurfacePlugin destroy: tear down moduleInstance and clear surfaceContexts.
	 */
	async destroy(): Promise<void> {
		if (!moduleInstance) return
		await moduleInstance.destroy()
		moduleInstance = null
		surfaceContexts.clear()
	},
	/**
	 * Open a surface: expose the surface API to the host and forward draw/close/variable calls to moduleInstance.
	 */
	async openSurface(
		surfaceId: string,
		_pluginInfo: PixelhueRemoteDeviceInfo,
		context: SurfaceContext,
	): Promise<OpenSurfaceResult> {
		surfaceContexts.set(surfaceId, context)

		const surface = {
			surfaceId,
			productName: PIXELHUE_U5_MINI_NAME,
			/** Surface init (no extra setup for this module) */
			async init(): Promise<void> {},
			/** Surface close: remove context and close the underlying connection. */
			async close(): Promise<void> {
				disconnectContext(surfaceId)
				await moduleInstance?.closeDevice(surfaceId)
			},
			async updateConfig(_config: Record<string, unknown>): Promise<void> {},
			async ready(): Promise<void> {},
			/** Blank the surface */
			async blank(): Promise<void> {
				await moduleInstance?.blankSurface(surfaceId)
			},
			/** Draw: map host draw props to moduleInstance.draw parameters. */
			async draw(signal: AbortSignal, props: SurfaceDrawProps): Promise<void> {
				if (signal.aborted) return
				if (!props?.controlId) return
				const imageBuf = props.image ? Buffer.from(props.image) : undefined
				const page = (props as unknown as Record<string, unknown>).pageNumber ?? 1
				await moduleInstance?.draw(surfaceId, [
					{
						controlId: String(props.controlId),
						image: imageBuf,
						page,
					},
				])
			},
			/** Forward variable updates to moduleInstance */
			async onVariableValue(name: string, value: unknown): Promise<void> {
				await moduleInstance?.onVariableValue(surfaceId, name, value)
			},
			/** Locked-state display */
			async showLockedStatus(locked: boolean, characterCount: number): Promise<void> {
				await moduleInstance?.showLockedStatus(surfaceId, locked, characterCount)
			},
			/** Brightness: not implemented; matches registerProps.brightness=false */
			async setBrightness(_brightness: number): Promise<void> {},
			/** Status card: no Satellite-style status cards */
			async showStatus(_signal: AbortSignal, _cardGenerator: CardGenerator, _statusMessage: string): Promise<void> {},
		}

		return {
			surface,
			registerProps: {
				brightness: false,
				surfaceLayout: DEFAULT_SURFACE_LAYOUT as any,
				pincodeMap: null,
				location: null,
				configFields: null,
			},
		}
	},
}

export default plugin
