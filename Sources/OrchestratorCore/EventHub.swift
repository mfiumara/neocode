import Foundation

public actor EventHub {
  private var continuations: [UUID: AsyncStream<AgentEvent>.Continuation] = [:]

  public init() {}

  public func stream() -> AsyncStream<AgentEvent> {
    let id = UUID()
    return AsyncStream { continuation in
      continuations[id] = continuation
      continuation.onTermination = { _ in
        Task { await self.remove(id) }
      }
    }
  }

  public func publish(_ event: AgentEvent) {
    for continuation in continuations.values {
      continuation.yield(event)
    }
  }

  public func finish() {
    for continuation in continuations.values {
      continuation.finish()
    }
    continuations.removeAll()
  }

  private func remove(_ id: UUID) {
    continuations.removeValue(forKey: id)
  }
}
