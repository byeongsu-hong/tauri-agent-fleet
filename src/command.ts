import { spawn } from 'node:child_process'

export interface CommandResult { stdout: string; stderr: string; code: number }

export async function runCommand(
  command: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}
): Promise<CommandResult> {
  if (!command[0]) throw new Error('empty command')
  return await new Promise((resolve, reject) => {
    const child = spawn(command[0]!, command.slice(1), {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (data) => { stdout += data })
    child.stderr.on('data', (data) => { stderr += data })
    const timer = options.timeoutMs ? setTimeout(() => child.kill('SIGKILL'), options.timeoutMs) : undefined
    child.on('error', reject)
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      const result = { stdout, stderr, code: code ?? 1 }
      if (result.code === 0) resolve(result)
      else reject(new Error(`${command.join(' ')} exited ${result.code}${stderr ? `: ${stderr.trim()}` : ''}`))
    })
  })
}

export async function output(command: string[], cwd?: string): Promise<string> {
  return (await runCommand(command, { cwd })).stdout.trim()
}
