import { BigNumber } from 'bignumber.js'
import * as util from 'ethereumjs-util'
import { Buffer } from 'safe-buffer'

const ethSigUtil = require('eth-sig-util')
const numberToBN = require('number-to-bn')

export type Uint256 = Buffer
export type Bytes = Buffer
export type Bytes32 = Buffer
export type Address = Buffer

export function recover (signature: string, data: any): string {
  const result = ethSigUtil.recoverPersonalSignature({ sig: signature, data: data})
  return result
}

export function bignumberToUint256 (n: BigNumber): Uint256 {
  return bignumberToBuffer(n)
}

export function bignumberToBuffer (n: BigNumber): Buffer {
  return util.setLengthLeft((util.toBuffer(numberToBN(n))), 32)
}

export function stringToBytes (str: string): Bytes {
  return stringToBuffer(str)
}

export function stringToBuffer (str: string): Bytes {
  return util.toBuffer(str)
}

export function stringToAddress (str: string): Address {
  return util.toBuffer(str)
}

export function bufferTo0xString (buf: Buffer): string {
  return util.addHexPrefix(buf.toString('hex'))
}

export function bufferArrayTo0xString (bufferArray: Buffer[]): string {
  return util.addHexPrefix(Buffer.concat(bufferArray).toString('hex'))
}

export function keccak256 (...args: Buffer[]): Bytes32 {
  return util.sha3(Buffer.concat(args))
}

export function keccak256FromStrings (...args: string[]): Bytes32 {
  return util.sha3(Buffer.concat(args.map(stringToBuffer)))
}

export function bytesTo0xString (input: Bytes): string {
  return bufferTo0xString(input)
}

export function bytes32To0xString (input: Bytes32): string {
  return bufferTo0xString(input)
}

export function printBufferArrayAs0xString (bufs: Buffer[]): void {
  bufs.map((el: Buffer) => {
    console.log(bufferTo0xString(el))
  })
}

export function nullAddress (): string {
  return util.addHexPrefix(''.padEnd(40, '0'))
}
