/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect, jest } from '@jest/globals';
import { RTCPeerConnection } from '../../src/polyfill/index';
import { PeerConnection } from '../../src/lib/index';

describe('polyfill', () => {
    // Default is 5000 ms but we need more
    jest.setTimeout(30000);

	test('generateCertificate should throw', async () => {
		await expect(async () => {
			await RTCPeerConnection.generateCertificate();
		}).rejects.toEqual(new DOMException('Not implemented'));
	});

	test('can assign polyfill to global type', () => {
		// complication check to ensure the interface is implemented correctly
		const pc: globalThis.RTCPeerConnection = new RTCPeerConnection()
		expect(pc).toBeTruthy()
	})

	test('P2P Test', () => {
		return new Promise<void>((done) => {
			// Mocks
			const p1ConnectionStateMock = jest.fn();
			const p1IceConnectionStateMock = jest.fn();
			const p1IceGatheringStateMock = jest.fn();
			const p1IceCandidateMock = jest.fn();
			const p1SDPMock = jest.fn();
			const p1DCMock = jest.fn();
			const p1MessageMock = jest.fn();
			const p2ConnectionStateMock = jest.fn();
			const p2IceConnectionStateMock = jest.fn();
			const p2IceGatheringStateMock = jest.fn();
			const p2IceCandidateMock = jest.fn();
			const p2SDPMock = jest.fn();
			const p2DCMock = jest.fn();
			const p2MessageMock = jest.fn();

			const peer1 = new RTCPeerConnection({
				peerIdentity: 'peer1',
				iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }],
			});

			const peer2 = new RTCPeerConnection({
				peerIdentity: 'peer2',
				iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }],
			});

			let dc1: RTCDataChannel = null;
			let dc2: RTCDataChannel = null;

			// Creates a fixed binary data for testing
			function createBinaryTestData(): ArrayBufferView {
				const binaryData = new Uint8Array(17);
				const dv = new DataView(binaryData.buffer);
				dv.setInt8(0, 123);
				dv.setFloat32(1, 123.456);
				dv.setUint32(5, 987654321);
				dv.setFloat64(9, 789.012);
				return binaryData;
			}

			// Compares the received binary data to the expected value of the fixed binary data
			function analyzeBinaryTestData(binaryData: ArrayBufferLike): boolean {
				const dv = new DataView(binaryData);
				return (dv.getInt8(0)==123 && dv.getFloat32(1)==Math.fround(123.456) && dv.getUint32(5)==987654321 && dv.getFloat64(9)==789.012);
			}

			// We will set the "binaryType" and then send/receive the "data" from the datachannel in each test, and then compare them.
			// For example, the first line will send a "Hello" string after setting binaryType to "arraybuffer".
			const testMessages = [
				{ binaryType: 'arraybuffer', data: 'Hello' },
				{ binaryType: 'arraybuffer', data: createBinaryTestData() },
				{ binaryType: 'blob', data: createBinaryTestData() }
			];

			// Index of the message in testMessages that we are currently testing.
			let currentIndex: number = -1;

			// We run this function to analyze the data just after receiving it from the datachannel.
			async function analyzeData(idx: number, data: string|Blob|ArrayBuffer): Promise<boolean> {
				switch(idx){
					case 0: // binaryType is not used here because data is a string ("Hello").
						return (data as string)==testMessages[idx].data;
					case 1: // binaryType is "arraybuffer" and data is expected to be an ArrayBuffer.
						return analyzeBinaryTestData(data as ArrayBufferLike);
					case 2: // binaryType is "blob" and data is expected to be a Buffer.
						return analyzeBinaryTestData(await (data as Blob).arrayBuffer());
				}
				return false;
			}

			async function finalizeTest(): Promise<void> {
				peer1.close();
				peer2.close();

                // State Callbacks
				expect(p1ConnectionStateMock.mock.calls.length).toBeGreaterThanOrEqual(1);
				expect(p2ConnectionStateMock.mock.calls.length).toBeGreaterThanOrEqual(1);
				expect(p1IceConnectionStateMock.mock.calls.length).toBeGreaterThanOrEqual(1);
				expect(p2IceConnectionStateMock.mock.calls.length).toBeGreaterThanOrEqual(1);
				expect(p1IceGatheringStateMock.mock.calls.length).toBeGreaterThanOrEqual(1);
				expect(p2IceGatheringStateMock.mock.calls.length).toBeGreaterThanOrEqual(1);

                // SDP
				expect(p1SDPMock.mock.calls.length).toBe(1);
				expect(p2SDPMock.mock.calls.length).toBe(1);

				// Candidates
				expect(p1IceCandidateMock.mock.calls.length).toBeGreaterThanOrEqual(1);
				expect(p2IceCandidateMock.mock.calls.length).toBeGreaterThanOrEqual(1);

                // DataChannel
				expect(p1DCMock.mock.calls.length).toBe(1);
				expect(p2DCMock.mock.calls.length).toBe(1);

				expect(p1MessageMock.mock.calls.length).toBe(3);
				expect(p2MessageMock.mock.calls.length).toBe(3);

				// Analyze and compare received messages
				expect(await analyzeData(0, p1MessageMock.mock.calls[0][0] as any)).toEqual(true);
				expect(await analyzeData(1, p1MessageMock.mock.calls[1][0] as any)).toEqual(true);
				expect(await analyzeData(2, p1MessageMock.mock.calls[2][0] as any)).toEqual(true);

				expect(await analyzeData(0, p2MessageMock.mock.calls[0][0] as any)).toEqual(true);
				expect(await analyzeData(1, p2MessageMock.mock.calls[1][0] as any)).toEqual(true);
				expect(await analyzeData(2, p2MessageMock.mock.calls[2][0] as any)).toEqual(true);

				done();
			}

			// starts the next message-sending test
			async function nextSendTest(): Promise<void> {
				// Get the next test data
				const current = testMessages[++currentIndex];

				// If finished, quit
				if (!current){
					await finalizeTest();
					return;
				}

				// Assign the binaryType value
				dc1.binaryType = current.binaryType as BinaryType;
                // dc2 also is initialized ?
                if(dc2){
                    dc2.binaryType = current.binaryType as BinaryType;
                }

				// Send the test message
				// workaround for https://github.com/microsoft/TypeScript-DOM-lib-generator/issues/1973
				if (typeof current.data === 'string') {
					dc1.send(current.data);
				} else {
					dc1.send(current.data);
				}
			}

			// Set Callbacks
			peer1.onconnectionstatechange = (): void => {
				p1ConnectionStateMock();
			};
			peer1.oniceconnectionstatechange = (): void => {
				p1IceConnectionStateMock();
			};
			peer1.onicegatheringstatechange = (): void => {
				p1IceGatheringStateMock();
			};
			peer1.onicecandidate = (e): void => {
				p1IceCandidateMock();
				peer2.addIceCandidate(e.candidate);
			};

			// Set Callbacks
			peer2.onconnectionstatechange = (): void => {
				p2ConnectionStateMock();
			};
			peer2.oniceconnectionstatechange = (): void => {
				p2IceConnectionStateMock();
			};
			peer2.onicegatheringstatechange = (): void => {
				p2IceGatheringStateMock();
			};
			peer2.onicecandidate = (e): void => {
				p2IceCandidateMock();
				peer1.addIceCandidate(e.candidate);
			};
			peer2.ondatachannel = (dce): void => {
				p2DCMock();
				dc2 = dce.channel;
				dc2.onmessage = (msg): void => {
					p2MessageMock(msg.data);

					// send the received message from peer2 back to peer1
					dc2.send(msg.data);
				};
			};

			// Actions
			peer1
				.createOffer()
				.then((desc) => {
					p1SDPMock();
					peer2.setRemoteDescription(desc);
				})
				//.catch((err) => console.error(err));

			peer2
				.createAnswer()
				.then((answerDesc) => {
					p2SDPMock();
					peer1.setRemoteDescription(answerDesc);
				})
				//.catch((err) => console.error('Couldn't create answer', err));

			dc1 = peer1.createDataChannel('test-p2p');
			dc1.onopen = (): void => {
				p1DCMock();
				nextSendTest();
			};
			dc1.onmessage = (msg): void => { // peer2 sends all messages back to peer1
				p1MessageMock(msg.data);
				nextSendTest();
			};
		});
	});

	test('it should accept a preconfigured PeerConnection', () => {
		const peerConnection = new PeerConnection('Peer', {
				iceServers: [],
		});

		// have to override write-only method in order to spy on it
		const originalFunc = peerConnection.state.bind(peerConnection);
		Object.defineProperty(peerConnection, 'state', {
				value: originalFunc,
				writable: true,
				enumerable: true,
		});

		const spy = jest.spyOn(peerConnection, 'state');
		const rtcPeerConnection = new RTCPeerConnection({
				peerConnection,
		});
		const connectionState = rtcPeerConnection.connectionState;
		expect(spy).toHaveBeenCalled();
		expect(connectionState).toEqual(originalFunc());
});
});
