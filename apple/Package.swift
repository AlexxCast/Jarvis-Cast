// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "JarvisFit",
    defaultLocalization: "it",
    platforms: [
        .iOS(.v16)
    ],
    products: [
        .library(
            name: "JarvisFit",
            targets: ["JarvisFit"]
        )
    ],
    targets: [
        .target(
            name: "JarvisFit",
            path: "JarvisFit"
        )
    ]
)
