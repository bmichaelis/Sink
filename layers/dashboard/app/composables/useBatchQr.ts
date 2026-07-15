import QRCodeStyling from 'qr-code-styling'

export function useBatchQr() {
  async function qrPngBlob(data: string, size = 512): Promise<Blob> {
    const qr = new QRCodeStyling({
      width: size,
      height: size,
      data,
      margin: 8,
      dotsOptions: { type: 'square', color: '#000000' },
      backgroundOptions: { color: '#ffffff' },
    })
    const raw = await qr.getRawData('png')
    if (!raw)
      throw new Error('QR generation failed')
    return raw as Blob
  }

  return { qrPngBlob }
}
