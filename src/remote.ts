import type { PixelhueSurfaceModule } from './surface-module.js'
import type {
	RemoteSurfaceConnectionInfo,
	SurfacePluginRemote,
	SurfacePluginRemoteEvents,
	SomeCompanionInputField,
} from '@companion-surface/base'
import EventEmitter from 'node:events'
import { remoteCheckConfigMatchesExpression, remoteConfigFields } from './constants.js'

export interface PixelhueRemoteDeviceInfo {
	type: 'remote'
}

export class PixelhueRemote
	extends EventEmitter<SurfacePluginRemoteEvents<PixelhueRemoteDeviceInfo>>
	implements SurfacePluginRemote<PixelhueRemoteDeviceInfo>
{
	readonly configFields: SomeCompanionInputField[] = remoteConfigFields

	// Used for "Already added" deduplication matching
	readonly checkConfigMatchesExpression = remoteCheckConfigMatchesExpression

	/**
	 * Resolve the current moduleInstance via closure to forward host start/stop calls.
	 */
	constructor(private readonly getModuleInstance: () => PixelhueSurfaceModule | null) {
		super()
	}
	rejectSurface(): void {}
	/**
	 * Called when the host starts connections; forwards to moduleInstance.setupRemoteConnections.
	 */
	async startConnections(connectionInfos: RemoteSurfaceConnectionInfo[]): Promise<void> {
		const moduleInstance = this.getModuleInstance()
		if (!moduleInstance) return
		await moduleInstance.setupRemoteConnections(connectionInfos)
	}

	/**
	 * Called when the host stops connections; forwards to moduleInstance.stopRemoteConnections.
	 */
	async stopConnections(connectionIds: string[]): Promise<void> {
		const moduleInstance = this.getModuleInstance()
		await moduleInstance?.stopRemoteConnections?.(connectionIds)
	}
}
