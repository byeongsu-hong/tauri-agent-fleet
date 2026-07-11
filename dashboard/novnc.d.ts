declare module '@novnc/novnc' {
  export default class RFB {
    constructor(target: Element, url: string, options?: { shared?: boolean })
    viewOnly: boolean
    scaleViewport: boolean
    resizeSession: boolean
    disconnect(): void
  }
}
