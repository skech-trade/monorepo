// What the wallet SDKs and the shared code expect of a JavaScript engine, before anything else loads.
import 'fast-text-encoding'
import 'react-native-get-random-values'
// Privy's documented set: normalize, atob/btoa and the like, each only where the engine lacks it.
import '@ethersproject/shims'
import structuredClone from '@ungap/structured-clone'
import { Buffer } from 'buffer'
import { install } from 'react-native-quick-crypto'

if (!('structuredClone' in globalThis)) globalThis.structuredClone = structuredClone
if (!('Buffer' in globalThis)) globalThis.Buffer = Buffer
// WebCrypto (crypto.subtle) for the shared SHA-256.
install()
