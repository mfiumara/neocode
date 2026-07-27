import Darwin
import Foundation

public actor PortAllocator {
  private var reserved = Set<UInt16>()

  public init() {}

  public func reserve() async throws -> UInt16 {
    for _ in 0..<64 {
      let candidate = UInt16.random(in: 41_000...59_000)
      guard !reserved.contains(candidate) else { continue }
      guard try await isAvailable(candidate) else { continue }
      reserved.insert(candidate)
      return candidate
    }
    throw OrchestrationError.invalidState("Could not allocate an available preview port.")
  }

  public func reserve(_ port: UInt16) async throws {
    guard !reserved.contains(port), try await isAvailable(port) else {
      throw OrchestrationError.invalidState("Port \(port) is already in use.")
    }
    reserved.insert(port)
  }

  public func release(_ port: UInt16) {
    reserved.remove(port)
  }

  private func isAvailable(_ port: UInt16) async throws -> Bool {
    let descriptor = socket(AF_INET, SOCK_STREAM, 0)
    guard descriptor >= 0 else { return false }
    defer { Darwin.close(descriptor) }

    var address = sockaddr_in()
    address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
    address.sin_family = sa_family_t(AF_INET)
    address.sin_port = port.bigEndian
    address.sin_addr = in_addr(s_addr: inet_addr("127.0.0.1"))

    let result = withUnsafePointer(to: &address) { pointer in
      pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
        Darwin.bind(
          descriptor,
          $0,
          socklen_t(MemoryLayout<sockaddr_in>.size)
        )
      }
    }
    return result == 0
  }
}
