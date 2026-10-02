export class OtlpDeliveryError extends Error {
  override readonly name = 'OtlpDeliveryError'
}

const deliveryTimeoutMs = 10_000

export const sendOtlp = async (endpoint: string, body: Uint8Array): Promise<void> => {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    signal: AbortSignal.timeout(deliveryTimeoutMs),
  })
  await response.arrayBuffer()
  if (!response.ok) {
    throw new OtlpDeliveryError(`the OTLP receiver at ${endpoint} answered ${String(response.status)}`)
  }
}
