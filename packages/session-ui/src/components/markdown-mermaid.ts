/// <reference types="vite/client" />

import DOMPurify from "dompurify"

type Mermaid = typeof import("mermaid")["default"]

declare global {
  interface Window {
    mermaid?: Mermaid
  }
}

let mermaid: Promise<Mermaid> | undefined
let renderChain = Promise.resolve()
let id = 0

const languages = new Set(["mermaid", "mmd", "graphmermaid"])
const svgSanitizeConfig = {
  USE_PROFILES: { svg: true, svgFilters: true },
  SANITIZE_NAMED_PROPS: true,
}

export function isMermaidLanguage(language: string | undefined) {
  return languages.has(language?.trim().split(/\s+/, 1)[0]?.toLowerCase() ?? "")
}

export async function renderMermaid(source: string) {
  const task = renderChain.then(async () => {
    const instance = await loadMermaid()
    instance.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      theme: document.documentElement.dataset.colorScheme === "dark" ? "dark" : "default",
      fontFamily: "var(--font-family-sans)",
    })
    return instance.render(`opencode-mermaid-${Date.now()}-${++id}`, source).then((result) => sanitizeMermaidSvg(result.svg))
  })
  renderChain = task.then(
    () => undefined,
    () => undefined,
  )
  return task
}

async function loadMermaid() {
  if (window.mermaid) return window.mermaid
  mermaid ??= import("mermaid/dist/mermaid.min.js?url").then((module) => loadMermaidScript(module.default))
  return mermaid
}

function loadMermaidScript(scriptUrl: string) {
  return new Promise<Mermaid>((resolve, reject) => {
    const script = document.createElement("script")
    script.async = true
    script.src = scriptUrl
    script.onload = () => {
      if (window.mermaid) {
        resolve(window.mermaid)
        return
      }
      reject(new Error("Mermaid script loaded without exposing window.mermaid"))
    }
    script.onerror = () => reject(new Error("Failed to load Mermaid script"))
    document.head.appendChild(script)
  })
}

export function sanitizeMermaidSvg(svg: string) {
  if (!DOMPurify.isSupported) throw new Error("Mermaid SVG sanitization is unavailable")
  return DOMPurify.sanitize(svg, svgSanitizeConfig)
}

export function mermaidErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message
  return String(error)
}
