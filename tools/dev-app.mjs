#!/usr/bin/env node
import { spawn } from 'node:child_process'
import net from 'node:net'
import process from 'node:process'

const serverPort = Number(process.env.PORT ?? 3001)
const webPort = Number(process.env.WEB_PORT ?? 5173)

const children = new Set()
let shuttingDown = false

function spawnProcess(name, args) {
  const child = spawn('pnpm', args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
  })
  children.add(child)
  child.on('exit', (code, signal) => {
    children.delete(child)
    if (!shuttingDown && code !== 0) {
      console.error(`[app] ${name} exited with ${signal ?? code}`)
      shutdown(code ?? 1)
    }
  })
  return child
}

function waitForPort(port, { timeoutMs = 15000 } = {}) {
  const startedAt = Date.now()
  return new Promise((resolve, reject) => {
    const tryConnect = () => {
      const socket = net.createConnection({ host: '127.0.0.1', port })
      socket.once('connect', () => {
        socket.end()
        resolve()
      })
      socket.once('error', () => {
        socket.destroy()
        if (Date.now() - startedAt > timeoutMs) {
          reject(new Error(`timed out waiting for port ${port}`))
          return
        }
        setTimeout(tryConnect, 250)
      })
    }
    tryConnect()
  })
}

function shutdown(code = 0) {
  if (shuttingDown) return
  shuttingDown = true
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM')
  }
  setTimeout(() => {
    for (const child of children) {
      if (!child.killed) child.kill('SIGKILL')
    }
    process.exit(code)
  }, 2500).unref()
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

console.log(`[app] starting server on http://localhost:${serverPort}`)
spawnProcess('server', ['--filter', '@agent-team/server', 'exec', 'tsx', 'src/main.ts'])

try {
  await waitForPort(serverPort)
} catch (err) {
  console.error(`[app] ${err instanceof Error ? err.message : String(err)}`)
  shutdown(1)
}

console.log(`[app] starting web on http://localhost:${webPort}`)
spawnProcess('web', ['--filter', '@agent-team/web', 'dev'])

await new Promise(() => {})
