import dotenv from 'dotenv'
import { join } from 'node:path'

dotenv.config({
  path: join(process.cwd(), 'server', '.env')
})

async function main(): Promise<void> {
  const { startVoiceFlowServer } = await import('./index')

  startVoiceFlowServer()
}

void main()
