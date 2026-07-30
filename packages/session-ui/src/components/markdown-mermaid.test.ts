import { describe, expect, it } from "bun:test"
import { isMermaidLanguage, mermaidErrorMessage } from "./markdown-mermaid"

describe("isMermaidLanguage", () => {
  it("recognizes supported mermaid fence languages", () => {
    expect(isMermaidLanguage("mermaid")).toBe(true)
    expect(isMermaidLanguage("Mermaid")).toBe(true)
    expect(isMermaidLanguage("mermaid title=flow")).toBe(true)
    expect(isMermaidLanguage("mmd")).toBe(true)
    expect(isMermaidLanguage("graphmermaid")).toBe(true)
  })

  it("ignores normal code fence languages", () => {
    expect(isMermaidLanguage("ts")).toBe(false)
    expect(isMermaidLanguage("java")).toBe(false)
    expect(isMermaidLanguage(undefined)).toBe(false)
  })
})

describe("mermaidErrorMessage", () => {
  it("keeps useful error text", () => {
    expect(mermaidErrorMessage(new Error("parse failed"))).toBe("parse failed")
    expect(mermaidErrorMessage("bad graph")).toBe("bad graph")
  })
})
