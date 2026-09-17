class VoiceFlowPCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super()

    this.targetRate = 16000
    this.targetChunkSamples = 1600
    this.sourceChunkSamples = Math.max(1, Math.round(sampleRate * 0.1))
    this.pending = []
  }

  process(inputs) {
    const input = inputs[0]?.[0]

    if (!input) {
      return true
    }

    for (let index = 0; index < input.length; index += 1) {
      this.pending.push(input[index])
    }

    while (this.pending.length >= this.sourceChunkSamples) {
      const source = this.pending.slice(0, this.sourceChunkSamples)
      this.pending = this.pending.slice(this.sourceChunkSamples)

      const pcm = new Int16Array(this.targetChunkSamples)

      for (let index = 0; index < this.targetChunkSamples; index += 1) {
        const position = (index * (source.length - 1)) / (this.targetChunkSamples - 1)
        const leftIndex = Math.floor(position)
        const rightIndex = Math.min(leftIndex + 1, source.length - 1)
        const fraction = position - leftIndex
        const sample =
          source[leftIndex] * (1 - fraction) + source[rightIndex] * fraction
        const clamped = Math.max(-1, Math.min(1, sample))

        pcm[index] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff
      }

      this.port.postMessage(pcm.buffer, [pcm.buffer])
    }

    return true
  }
}

registerProcessor('voiceflow-pcm', VoiceFlowPCMProcessor)
