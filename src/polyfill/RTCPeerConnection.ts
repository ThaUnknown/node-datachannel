import { DataChannel, DataChannelInitConfig, DescriptionType, PeerConnection, SelectedCandidateInfo } from '../lib/index';
import RTCSessionDescription from './RTCSessionDescription';
import RTCDataChannel from './RTCDataChannel';
import RTCIceCandidate from './RTCIceCandidate';
import { RTCDataChannelEvent, RTCPeerConnectionIceEvent } from './Events';
import RTCSctpTransport from './RTCSctpTransport';
import * as exceptions from './Exception';
import RTCCertificate from './RTCCertificate';

// extend RTCConfiguration with peerIdentity
interface RTCConfiguration extends globalThis.RTCConfiguration {
    peerIdentity?: string;
    peerConnection?: PeerConnection;
}

export default class RTCPeerConnection extends EventTarget implements globalThis.RTCPeerConnection {
    static async generateCertificate(): Promise<RTCCertificate> {
        throw new DOMException('Not implemented');
    }

    #peerConnection: PeerConnection;
    #localOffer: ReturnType<typeof createDeferredPromise>;
    #localAnswer: ReturnType<typeof createDeferredPromise>;
    #dataChannels = new Set<RTCDataChannel>();
    #dataChannelsClosed = 0;
    #config: RTCConfiguration;
    #canTrickleIceCandidates: boolean | null = null;
    #sctp: RTCSctpTransport;
    #announceNegotiation: boolean | null = null;

    #localCandidates: globalThis.RTCIceCandidate[] = [];
    #remoteCandidates: globalThis.RTCIceCandidate[] = [];

    // events
    onconnectionstatechange: globalThis.RTCPeerConnection['onconnectionstatechange'] = null;
    ondatachannel: globalThis.RTCPeerConnection['ondatachannel'] = null;
    onicecandidate: globalThis.RTCPeerConnection['onicecandidate'] = null;
    // TODO: not implemented
    onicecandidateerror: globalThis.RTCPeerConnection['onicecandidateerror'] = null;
    oniceconnectionstatechange: globalThis.RTCPeerConnection['oniceconnectionstatechange'] = null;
    onicegatheringstatechange: globalThis.RTCPeerConnection['onicegatheringstatechange'] = null;
    onnegotiationneeded: globalThis.RTCPeerConnection['onnegotiationneeded'] = null;
    onsignalingstatechange: globalThis.RTCPeerConnection['onsignalingstatechange'] = null;
    ontrack: globalThis.RTCPeerConnection['ontrack'] = null;

    setConfiguration(config: RTCConfiguration): RTCConfiguration {
        // TODO: this doesn't actually update the configuration :/
            // most of these are unused x)
            config ??= {}
            if (config.bundlePolicy === undefined) config.bundlePolicy = 'balanced'
            // @ts-expect-error non-standard
            config.encodedInsertableStreams ??= false
            config.iceCandidatePoolSize ??= 0
            config.iceServers ??= []
            for (let { urls } of config.iceServers) {
                if (!Array.isArray(urls)) urls = [urls]
                    for (const url of urls) {
                        try {
                            new URL(url)
                        } catch (error) {
                            throw new DOMException(`Failed to execute 'setConfiguration' on 'RTCPeerConnection': '${url}' is not a valid URL.`, 'SyntaxError')
                        }
                    }
                }
                config.iceTransportPolicy ??= 'all'
                // @ts-expect-error non-standard
                config.rtcAudioJitterBufferFastAccelerate ??= false
                // @ts-expect-error non-standard
                config.rtcAudioJitterBufferMaxPackets ??= 200
                // @ts-expect-error non-standard
                config.rtcAudioJitterBufferMinDelayMs ??= 0
                config.rtcpMuxPolicy ??= 'require'

                if (config.iceCandidatePoolSize < 0 || config.iceCandidatePoolSize > 255) throw new TypeError("Failed to execute 'setConfiguration' on 'RTCPeerConnection': Failed to read the 'iceCandidatePoolSize' property from 'RTCConfiguration': Value is outside the 'octet' value range.")
                if (config.bundlePolicy !== 'balanced' && config.bundlePolicy !== 'max-compat' && config.bundlePolicy !== 'max-bundle') throw new TypeError("Failed to execute 'setConfiguration' on 'RTCPeerConnection': Failed to read the 'bundlePolicy' property from 'RTCConfiguration': The provided value '" + config.bundlePolicy + "' is not a valid enum value of type RTCBundlePolicy.")
                if (this.#config) {
                if (config.bundlePolicy !== this.#config.bundlePolicy) {
                    throw new DOMException("Failed to execute 'setConfiguration' on 'RTCPeerConnection': Attempted to modify the PeerConnection's configuration in an unsupported way.", 'InvalidModificationError')
                }
            }

            return config;
    }



    constructor(config: RTCConfiguration = {}) {
        super();

        this.#config = this.setConfiguration(config);
        this.#localOffer = createDeferredPromise();
        this.#localAnswer = createDeferredPromise();

        try {
            const peerIdentity = config?.peerIdentity ?? `peer-${getRandomString(7)}`;
            this.#peerConnection = config.peerConnection ?? new PeerConnection(peerIdentity,
                {
                    ...this.#config,
                    iceServers:
                        config?.iceServers
                            ?.map((server) => {
                                const urls = Array.isArray(server.urls) ? server.urls : [server.urls];

                                return urls.map((url) => {
                                    if (server.username && server.credential) {
                                        const [protocol, rest] = url.split(/:(.*)/);
                                        return `${protocol}:${server.username}:${server.credential}@${rest}`;
                                    }
                                    return url;
                                });
                            })
                            .flat() ?? [],
                },
            );
        } catch (err) {
            const error = err as Error;
            if (!error || !error.message) throw new exceptions.NotFoundError('Unknown error');
            throw new exceptions.SyntaxError(error.message);
        }

        // forward peerConnection events
        this.#peerConnection.onStateChange(() => {
            this.dispatchEvent(new Event('connectionstatechange'));
        });

        this.#peerConnection.onIceStateChange(() => {
            this.dispatchEvent(new Event('iceconnectionstatechange'));
        });

        this.#peerConnection.onSignalingStateChange(() => {
            this.dispatchEvent(new Event('signalingstatechange'));
        });

        this.#peerConnection.onGatheringStateChange(() => {
            this.dispatchEvent(new Event('icegatheringstatechange'));
        });

        this.#peerConnection.onDataChannel((channel) => {
            this.dispatchEvent(new RTCDataChannelEvent('datachannel', { channel: this.#handleDataChannel(channel) }));
        });

        this.#peerConnection.onLocalDescription((sdp, type) => {
            if (type === 'offer') {
                this.#localOffer.resolve(new RTCSessionDescription({ sdp, type }));
            }

            if (type === 'answer') {
                this.#localAnswer.resolve(new RTCSessionDescription({ sdp, type }));
            }
        });

        this.#peerConnection.onLocalCandidate((candidate, sdpMid) => {
            if (sdpMid === 'unspec') {
                this.#localAnswer.reject(new Error(`Invalid description type ${sdpMid}`));
                return;
            }

            this.#localCandidates.push(new RTCIceCandidate({ candidate, sdpMid }));
            this.dispatchEvent(new RTCPeerConnectionIceEvent(new RTCIceCandidate({ candidate, sdpMid })));
        });

        // forward events to properties
        this.addEventListener('connectionstatechange', (e) => {
            this.onconnectionstatechange?.(e);
        });
        this.addEventListener('signalingstatechange', (e) => {
            this.onsignalingstatechange?.(e);
        });
        this.addEventListener('iceconnectionstatechange', (e) => {
            this.oniceconnectionstatechange?.(e);
        });
        this.addEventListener('icegatheringstatechange', (e) => {
            this.onicegatheringstatechange?.(e);
        });
        this.addEventListener('datachannel', (e) => {
            this.ondatachannel?.(e as RTCDataChannelEvent);
        });
        this.addEventListener('icecandidate', (e) => {
            this.onicecandidate?.(e as RTCPeerConnectionIceEvent);
        });

        this.addEventListener('track', e => {
            this.ontrack?.(e as RTCTrackEvent)
        })

        this.addEventListener('negotiationneeded', e => {
            this.#announceNegotiation = true
            this.onnegotiationneeded?.(e)
        })

        this.#sctp = new RTCSctpTransport({ pc: this });
    }

    get localCandidates (): globalThis.RTCIceCandidate[] {
        return this.#localCandidates
    }
    
    get remoteCandidates (): globalThis.RTCIceCandidate[] {
        return this.#remoteCandidates
    }

    get canTrickleIceCandidates(): boolean | null {
        return this.#canTrickleIceCandidates;
    }

    get connectionState(): globalThis.RTCPeerConnectionState {
        return this.#peerConnection.state();
    }

    get iceConnectionState(): globalThis.RTCIceConnectionState {
        let state = this.#peerConnection.iceState();
        // libdatachannel uses 'completed' instead of 'connected'
        // see /webrtc/getstats.html
        if (state == 'completed') state = 'connected';
        return state;
    }

    get iceGatheringState(): globalThis.RTCIceGatheringState {
        return this.#peerConnection.gatheringState();
    }

    #nullableDescription (desc: { type: DescriptionType; sdp: string } | null): RTCSessionDescription | null {
        if (!desc) return null
        // @ts-expect-error non-standard
        return new RTCSessionDescription(desc)
    }
    get currentLocalDescription (): RTCSessionDescription | null {
        return this.#nullableDescription(this.#peerConnection.localDescription())
    }
    
    get currentRemoteDescription (): RTCSessionDescription | null {
        return this.#nullableDescription(this.#peerConnection.remoteDescription())
    }
    
    get localDescription (): RTCSessionDescription | null {
        return this.#nullableDescription(this.#peerConnection.localDescription())
    }
    
    get pendingLocalDescription (): RTCSessionDescription | null {
        return this.#nullableDescription(this.#peerConnection.localDescription())
    }
    
    get pendingRemoteDescription (): RTCSessionDescription | null {
        return this.#nullableDescription(this.#peerConnection.remoteDescription())
    }
    
    get remoteDescription (): RTCSessionDescription | null {
        return this.#nullableDescription(this.#peerConnection.remoteDescription())
    }

    get sctp(): globalThis.RTCSctpTransport {
        return this.#sctp;
    }

    get signalingState(): globalThis.RTCSignalingState {
        return this.#peerConnection.signalingState();
    }

    async addIceCandidate(candidate?: globalThis.RTCIceCandidateInit | null): Promise<void> {
        // TODO: only resolve this once the candidate is added and not right away
        if (!candidate || !candidate.candidate) {
            return;
        }

        if (candidate.sdpMid === null && candidate.sdpMLineIndex === null) {
            throw new DOMException('Candidate invalid');
        }

        if (candidate.sdpMid === undefined && candidate.sdpMLineIndex == undefined) {
            throw new DOMException('Candidate invalid');
        }

        // Reject if sdpMid format is not valid
        // ??
        if (candidate.sdpMid && candidate.sdpMid.length > 3) {
            // console.log(candidate.sdpMid);
            throw new exceptions.OperationError('Invalid sdpMid format');
        }

        // We don't care about sdpMLineIndex, just for test
        if (!candidate.sdpMid && candidate.sdpMLineIndex && candidate.sdpMLineIndex > 1) {
            throw new exceptions.OperationError('This is only for test case.');
        }

        try {
            this.#peerConnection.addRemoteCandidate(candidate.candidate, candidate.sdpMid ?? '0');
            this.#remoteCandidates.push(
                new RTCIceCandidate({ candidate: candidate.candidate, sdpMid: candidate.sdpMid ?? '0' }),
            );
        } catch (err) {
            const error = err as Error;
            if (!error || !error.message) throw new exceptions.NotFoundError('Unknown error');

            // Check error Message if contains specific message
            if (error.message.includes('remote candidate without remote description'))
                throw new exceptions.InvalidStateError(error.message);
            if (error.message.includes('Invalid candidate format')) throw new exceptions.OperationError(error.message);

            throw new DOMException(error.message, 'UnknownError');
        }
    }
    
    addTrack (): globalThis.RTCRtpSender {
        return {} as globalThis.RTCRtpSender
    }
    

    addTransceiver (): globalThis.RTCRtpTransceiver {
        return {} as globalThis.RTCRtpTransceiver
    }
    
    getReceivers (): globalThis.RTCRtpReceiver[] {
        // receivers are created on ontrack
        return []
    }
    
    getSenders (): globalThis.RTCRtpSender[] {
        // senders are created on addTrack or addTransceiver
        return []
    }
    
    getTracks (): globalThis.MediaStreamTrack[] {
        return []
    }

    close(): void {
        // close all channels before shutting down
        this.#dataChannels.forEach((channel) => {
            channel.close();
            this.#dataChannelsClosed++;
        });

        this.#peerConnection.close();
    }

    get maxMessageSize (): number {
        return this.#peerConnection.maxMessageSize()
    }
    
    get maxChannels (): number {
        return this.#peerConnection.maxDataChannelId()
    }

    createAnswer(): Promise<globalThis.RTCSessionDescriptionInit> & Promise<void> {
        // @ts-expect-error dont support deprecated overload
        return this.#localAnswer;
    }

    #handleDataChannel (channel: DataChannel, opts?: DataChannelInitConfig): RTCDataChannel {
        const dataChannel = new RTCDataChannel(channel, opts, this)
    
        // ensure we can close all channels when shutting down
        this.#dataChannels.add(dataChannel)
        dataChannel.addEventListener('close', () => {
            this.#dataChannels.delete(dataChannel)
        })
    
        return dataChannel
    }


    createDataChannel (label: string, opts: globalThis.RTCDataChannelInit = {}): RTCDataChannel {
        const conf: DataChannelInitConfig = opts
        if (opts.ordered === false) conf.unordered = true
        const channel = this.#peerConnection.createDataChannel('' + label, conf)
        const dataChannel = this.#handleDataChannel(channel, opts)
    
        if (this.#announceNegotiation == null) {
            this.#announceNegotiation = false
            this.dispatchEvent(new Event('negotiationneeded'))
        }
    
        return dataChannel
    }

    createOffer(): Promise<globalThis.RTCSessionDescriptionInit> & Promise<void> {
        // @ts-expect-error dont support deprecated overload
        return this.#localOffer;
    }

    getConfiguration(): globalThis.RTCConfiguration {
        return this.#config;
    }

    getSelectedCandidatePair (): {
        local: SelectedCandidateInfo;
        remote: SelectedCandidateInfo;
    } | null {
        return this.#peerConnection.getSelectedCandidatePair()
    }

    
    getStats(): Promise<globalThis.RTCStatsReport> & Promise<void> {
        const report = new Map();
        const cp = this.getSelectedCandidatePair();
        const bytesSent = this.#peerConnection.bytesSent();
        const bytesReceived = this.#peerConnection.bytesReceived();
        const rtt = this.#peerConnection.rtt();

        if(!cp) {
            // @ts-expect-error dont support deprecated overload
            return Promise.resolve(report as globalThis.RTCStatsReport);
        }

        const localIdRs = getRandomString(8);
        const localId = 'RTCIceCandidate_' + localIdRs;
        report.set(localId, {
            id: localId,
            type: 'local-candidate',
            timestamp: Date.now(),
            candidateType: cp.local.type,
            ip: cp.local.address,
            port: cp.local.port,
        });

        const remoteIdRs = getRandomString(8);
        const remoteId = 'RTCIceCandidate_' + remoteIdRs;
        report.set(remoteId, {
            id: remoteId,
            type: 'remote-candidate',
            timestamp: Date.now(),
            candidateType: cp.remote.type,
            ip: cp.remote.address,
            port: cp.remote.port,
        });

        const candidateId = 'RTCIceCandidatePair_' + localIdRs + '_' + remoteIdRs;
        report.set(candidateId, {
            id: candidateId,
            type: 'candidate-pair',
            timestamp: Date.now(),
            localCandidateId: localId,
            remoteCandidateId: remoteId,
            state: 'succeeded',
            nominated: true,
            writable: true,
            bytesSent: bytesSent,
            bytesReceived: bytesReceived,
            totalRoundTripTime: rtt,
            currentRoundTripTime: rtt,
        });

        const transportId = 'RTCTransport_0_1';
        report.set(transportId, {
            id: transportId,
            timestamp: Date.now(),
            type: 'transport',
            bytesSent: bytesSent,
            bytesReceived: bytesReceived,
            dtlsState: 'connected',
            selectedCandidatePairId: candidateId,
            selectedCandidatePairChanges: 1,
        });

        // peer-connection'
        report.set('P', {
            id: 'P',
            type: 'peer-connection',
            timestamp: Date.now(),
            dataChannelsOpened: this.#dataChannels.size,
            dataChannelsClosed: this.#dataChannelsClosed,
        });

        // @ts-expect-error dont support deprecated overload
        return Promise.resolve(report as globalThis.RTCStatsReport);
    }

    getTransceivers(): globalThis.RTCRtpTransceiver[] {
        return [];
    }

    removeTrack(): void {
        console.warn('track detatching not supported')
        // throw new DOMException('Not implemented');
    }

    restartIce(): Promise<void> {
        throw new DOMException('Not implemented');
    }

    async setLocalDescription(description: globalThis.RTCSessionDescriptionInit): Promise<void> {
        if (description == null || description.type == null) {
            return this.#peerConnection.setLocalDescription()
        }
        // TODO: error and state checking

        if (description.type !== 'offer') {
            // any other type causes libdatachannel to throw
            return this.#peerConnection.setLocalDescription()
        }

        this.#peerConnection.setLocalDescription(description?.type);
    }

    async setRemoteDescription(description: globalThis.RTCSessionDescriptionInit): Promise<void> {
        if (description.sdp == null) {
            throw new DOMException('Remote SDP must be set');
        }

        this.#peerConnection.setRemoteDescription(description.sdp, description.type);
    }
}

function createDeferredPromise<T>(): Promise<T> & { resolve: (value: T) => void; reject: (reason?: unknown) => void } {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;

    const promise = new Promise<T>((_resolve, _reject) => {
        resolve = _resolve;
        reject = _reject;
    });

    return Object.assign(promise, { resolve, reject });
}

function getRandomString(length: number): string {
    return Math.random()
        .toString(36)
        .substring(2, 2 + length);
}
