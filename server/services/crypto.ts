import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

/**
 * AES-256-GCM для секретов тенантов (docs/09 §9.2, §9.4): ключ из ENCRYPTION_KEY
 * (32 байта base64 или произвольная строка — тогда берётся sha256), в БД —
 * шифротекст + nonce + тег. Ротация — отдельной задачей с перешифрованием.
 */

function key(): Buffer {
  const raw = process.env.ENCRYPTION_KEY || ''
  if (!raw) throw new Error('ENCRYPTION_KEY не задан')
  try {
    const b = Buffer.from(raw, 'base64')
    if (b.length === 32) return b
  }
  catch { /* не base64 */ }
  return createHash('sha256').update(raw).digest()
}

export function encrypt(plain: string): { ciphertext: Buffer, nonce: Buffer } {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key(), nonce)
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return { ciphertext: Buffer.concat([enc, tag]), nonce }
}

export function decrypt(ciphertext: Buffer, nonce: Buffer): string {
  const tag = ciphertext.subarray(ciphertext.length - 16)
  const enc = ciphertext.subarray(0, ciphertext.length - 16)
  const decipher = createDecipheriv('aes-256-gcm', key(), nonce)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8')
}
