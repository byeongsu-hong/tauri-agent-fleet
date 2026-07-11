import { execFile } from 'node:child_process'

interface CommandResult { stdout: string; stderr: string }

export async function runCommand(
  command: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; maxOutputBytes?: number } = {}
): Promise<CommandResult> {
  if (!command[0]) throw new Error('empty command')
  return await new Promise((resolve, reject) => {
    execFile(command[0]!, command.slice(1), {
      cwd: options.cwd,
      env: options.env,
      encoding: 'utf8',
      killSignal: 'SIGKILL',
      maxBuffer: options.maxOutputBytes ?? 16 * 1024 * 1024,
      timeout: options.timeoutMs
    }, (error, stdout, stderr) => {
      if (!error) return resolve({ stdout, stderr })
      const result = options.timeoutMs && error.killed ? `timed out after ${options.timeoutMs}ms` : `exited ${error.code ?? 1}`
      reject(new Error(`${command.join(' ')} ${result}${stderr ? `: ${stderr.trim()}` : ''}`, { cause: error }))
    })
  })
}

export async function output(command: string[], cwd?: string): Promise<string> {
  return (await runCommand(command, { ...(cwd === undefined ? {} : { cwd }) })).stdout.trim()
}
