#!/usr/bin/env swift

import AppKit
import Foundation

let canvasSize = 44
let scriptDirectory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
let defaultOutput = scriptDirectory
    .deletingLastPathComponent()
    .appendingPathComponent("resources/icons/tray-icon.png")
let output = CommandLine.arguments.dropFirst().first.map {
    URL(fileURLWithPath: $0, relativeTo: URL(fileURLWithPath: FileManager.default.currentDirectoryPath))
} ?? defaultOutput

guard let bitmap = NSBitmapImageRep(
    bitmapDataPlanes: nil,
    pixelsWide: canvasSize,
    pixelsHigh: canvasSize,
    bitsPerSample: 8,
    samplesPerPixel: 4,
    hasAlpha: true,
    isPlanar: false,
    colorSpaceName: .deviceRGB,
    bytesPerRow: 0,
    bitsPerPixel: 0
) else {
    fatalError("Unable to create the tray icon bitmap")
}

guard let graphicsContext = NSGraphicsContext(bitmapImageRep: bitmap) else {
    fatalError("Unable to create the tray icon graphics context")
}

NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = graphicsContext
graphicsContext.cgContext.clear(CGRect(x: 0, y: 0, width: canvasSize, height: canvasSize))
graphicsContext.cgContext.setAllowsAntialiasing(true)
graphicsContext.cgContext.setShouldAntialias(true)

NSColor.white.setFill()

// Keep the four collaborating surfaces readable after macOS renders the
// 44 px source at the menu bar's 22 pt size.
for rect in [
    NSRect(x: 6, y: 24, width: 14, height: 14),
    NSRect(x: 24, y: 24, width: 14, height: 14),
    NSRect(x: 6, y: 6, width: 14, height: 14),
    NSRect(x: 24, y: 6, width: 14, height: 14),
] {
    NSBezierPath(roundedRect: rect, xRadius: 4.5, yRadius: 4.5).fill()
}

let star = NSBezierPath()
star.move(to: NSPoint(x: 22, y: 14))
star.curve(to: NSPoint(x: 24, y: 20), controlPoint1: NSPoint(x: 22.5, y: 17.5), controlPoint2: NSPoint(x: 22.8, y: 19.2))
star.curve(to: NSPoint(x: 30, y: 22), controlPoint1: NSPoint(x: 24.8, y: 21.2), controlPoint2: NSPoint(x: 26.5, y: 21.5))
star.curve(to: NSPoint(x: 24, y: 24), controlPoint1: NSPoint(x: 26.5, y: 22.5), controlPoint2: NSPoint(x: 24.8, y: 22.8))
star.curve(to: NSPoint(x: 22, y: 30), controlPoint1: NSPoint(x: 22.8, y: 24.8), controlPoint2: NSPoint(x: 22.5, y: 26.5))
star.curve(to: NSPoint(x: 20, y: 24), controlPoint1: NSPoint(x: 21.5, y: 26.5), controlPoint2: NSPoint(x: 21.2, y: 24.8))
star.curve(to: NSPoint(x: 14, y: 22), controlPoint1: NSPoint(x: 19.2, y: 22.8), controlPoint2: NSPoint(x: 17.5, y: 22.5))
star.curve(to: NSPoint(x: 20, y: 20), controlPoint1: NSPoint(x: 17.5, y: 21.5), controlPoint2: NSPoint(x: 19.2, y: 21.2))
star.curve(to: NSPoint(x: 22, y: 14), controlPoint1: NSPoint(x: 21.2, y: 19.2), controlPoint2: NSPoint(x: 21.5, y: 17.5))
star.close()
star.fill()

NSGraphicsContext.restoreGraphicsState()

guard let png = bitmap.representation(using: .png, properties: [:]) else {
    fatalError("Unable to encode the tray icon as PNG")
}

try FileManager.default.createDirectory(
    at: output.deletingLastPathComponent(),
    withIntermediateDirectories: true
)
try png.write(to: output)
print("Generated \(output.path)")
