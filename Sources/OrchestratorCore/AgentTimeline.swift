import Foundation

public enum AgentTimelineItemKind: String, Sendable, Equatable {
  case userMessage
  case agentMessage
  case reasoning
  case activity
  case notice
  case error
}

public struct AgentTimelineItem: Identifiable, Sendable, Equatable {
  public var id: String
  public var kind: AgentTimelineItemKind
  public var title: String
  public var text: String
  public var agentID: String?
  public var activityID: String?
  public var firstSequence: Int64
  public var lastSequence: Int64
  public var timestamp: Date
  public var isInProgress: Bool

  public init(
    id: String,
    kind: AgentTimelineItemKind,
    title: String,
    text: String,
    agentID: String?,
    activityID: String? = nil,
    firstSequence: Int64,
    lastSequence: Int64,
    timestamp: Date,
    isInProgress: Bool = false
  ) {
    self.id = id
    self.kind = kind
    self.title = title
    self.text = text
    self.agentID = agentID
    self.activityID = activityID
    self.firstSequence = firstSequence
    self.lastSequence = lastSequence
    self.timestamp = timestamp
    self.isInProgress = isInProgress
  }
}

/// Turns lossless provider events into the small set of semantic rows a person
/// expects in a conversation. Raw events remain persisted for diagnostics, but
/// transport chatter, status heartbeats, and token-sized deltas never become
/// standalone UI cards.
public enum AgentTimelineProjection {
  public static func items(from events: [AgentEvent]) -> [AgentTimelineItem] {
    var items: [AgentTimelineItem] = []
    var activeAgentMessageIndex: Int?
    var activeReasoningIndex: Int?

    for event in events.sorted(by: eventOrder) {
      let semanticKind = semanticKind(for: event)

      switch semanticKind {
      case .ignored:
        // Transport and status events can arrive between two token deltas.
        // They are invisible in the product timeline and must not fragment the
        // semantic response they happen to bisect.
        continue

      case .userMessage:
        activeAgentMessageIndex = nil
        activeReasoningIndex = nil
        guard let text = meaningfulText(for: event) else { continue }
        let itemID = providerItemID(in: event)
        if let lastIndex = items.indices.last,
          items[lastIndex].kind == .userMessage,
          items[lastIndex].agentID == event.agentID,
          normalized(items[lastIndex].text) == normalized(text),
          itemID == nil || items[lastIndex].activityID == itemID
        {
          items[lastIndex].lastSequence = event.sequence
          items[lastIndex].timestamp = event.timestamp
          continue
        }
        items.append(
          item(
            event: event,
            kind: .userMessage,
            title: "You",
            text: text,
            activityID: itemID
          )
        )

      case .agentDelta:
        activeReasoningIndex = nil
        guard let text = streamingText(for: event), !text.isEmpty else { continue }
        if let index = activeAgentMessageIndex,
          items.indices.contains(index),
          items[index].agentID == event.agentID
        {
          items[index].text = appendDelta(text, to: items[index].text)
          items[index].lastSequence = event.sequence
          items[index].timestamp = event.timestamp
          items[index].isInProgress = true
        } else {
          var message = item(
            event: event,
            kind: .agentMessage,
            title: "Agent",
            text: text,
            isInProgress: true
          )
          // A delta is a fragment, so its boundary whitespace is semantic.
          // `item` trims complete messages, but doing that to the first token
          // turns `"Done. "` + `"Next"` into `"Done.Next"`.
          message.text = text
          items.append(message)
          activeAgentMessageIndex = items.index(before: items.endIndex)
        }

      case .agentMessage:
        activeReasoningIndex = nil
        guard let text = meaningfulText(for: event) else { continue }
        if let index = activeAgentMessageIndex,
          items.indices.contains(index),
          items[index].agentID == event.agentID,
          messagesRepresentSameResponse(items[index].text, text)
        {
          items[index].text = preferredFinalText(streamed: items[index].text, final: text)
          items[index].lastSequence = event.sequence
          items[index].timestamp = event.timestamp
          items[index].isInProgress = false
          activeAgentMessageIndex = nil
        } else {
          items.append(
            item(
              event: event,
              kind: .agentMessage,
              title: "Agent",
              text: text
            )
          )
          activeAgentMessageIndex = nil
        }

      case .reasoning:
        activeAgentMessageIndex = nil
        guard let text = meaningfulText(for: event) else { continue }
        if let index = activeReasoningIndex,
          items.indices.contains(index),
          items[index].agentID == event.agentID
        {
          items[index].text = appendDelta(text, to: items[index].text)
          items[index].lastSequence = event.sequence
          items[index].timestamp = event.timestamp
        } else {
          items.append(
            item(
              event: event,
              kind: .reasoning,
              title: "Reasoning",
              text: text,
              isInProgress: event.kind == .reasoning
            )
          )
          activeReasoningIndex = items.index(before: items.endIndex)
        }

      case .activity:
        activeAgentMessageIndex = nil
        activeReasoningIndex = nil
        mergeActivity(event, into: &items)

      case .notice:
        activeAgentMessageIndex = nil
        activeReasoningIndex = nil
        guard let text = meaningfulText(for: event) else { continue }
        items.append(
          item(
            event: event,
            kind: .notice,
            title: noticeTitle(for: event.kind),
            text: text
          )
        )

      case .error:
        activeAgentMessageIndex = nil
        activeReasoningIndex = nil
        let text = meaningfulText(for: event) ?? "The provider reported an error."
        items.append(
          item(
            event: event,
            kind: .error,
            title: "Error",
            text: text
          )
        )
      }
    }

    return items
  }

  private enum SemanticKind {
    case userMessage
    case agentDelta
    case agentMessage
    case reasoning
    case activity
    case notice
    case error
    case ignored
  }

  private static func semanticKind(for event: AgentEvent) -> SemanticKind {
    switch providerItemType(in: event) {
    case "userMessage":
      return .userMessage
    case "agentMessage":
      return event.kind == .messageDelta ? .agentDelta : .agentMessage
    case "reasoning":
      return .reasoning
    case "commandExecution", "fileChange", "mcpToolCall", "webSearch":
      return .activity
    default:
      break
    }

    return switch event.kind {
    case .userMessage: .userMessage
    case .messageDelta: .agentDelta
    case .agentMessage: .agentMessage
    case .reasoning: .reasoning
    case .toolStarted, .toolUpdated, .toolCompleted, .command, .fileChange:
      .activity
    case .approvalRequested, .inputRequested:
      .notice
    case .error:
      .error
    case .approvalResolved, .inputResolved, .usage, .status, .raw:
      .ignored
    }
  }

  private static func mergeActivity(
    _ event: AgentEvent,
    into items: inout [AgentTimelineItem]
  ) {
    let activityID = providerItemID(in: event)
    let text = activityText(for: event)
    let title = activityTitle(for: event)
    let isInProgress = event.kind == .toolStarted || event.kind == .toolUpdated

    if let activityID,
      let existingIndex = items.lastIndex(where: {
        $0.kind == .activity && $0.activityID == activityID
      })
    {
      if !text.isEmpty {
        items[existingIndex].text = text
      }
      items[existingIndex].title = title
      items[existingIndex].lastSequence = event.sequence
      items[existingIndex].timestamp = event.timestamp
      items[existingIndex].isInProgress = isInProgress
      return
    }

    // A completion without an identifiable start and without any useful
    // description is transport noise, not a timeline row.
    guard !text.isEmpty || event.kind == .command || event.kind == .fileChange else {
      return
    }
    items.append(
      item(
        event: event,
        kind: .activity,
        title: title,
        text: text,
        activityID: activityID,
        isInProgress: isInProgress
      )
    )
  }

  private static func item(
    event: AgentEvent,
    kind: AgentTimelineItemKind,
    title: String,
    text: String,
    activityID: String? = nil,
    isInProgress: Bool = false
  ) -> AgentTimelineItem {
    AgentTimelineItem(
      id: event.id,
      kind: kind,
      title: title,
      text: text.trimmingCharacters(in: .whitespacesAndNewlines),
      agentID: event.agentID,
      activityID: activityID,
      firstSequence: event.sequence,
      lastSequence: event.sequence,
      timestamp: event.timestamp,
      isInProgress: isInProgress
    )
  }

  private static func meaningfulText(for event: AgentEvent) -> String? {
    let candidates = [
      event.payload["text"]?.stringValue,
      event.payload["message"]?.stringValue,
      event.payload["summary"]?.stringValue,
      event.payload["command"]?.stringValue,
      event.payload["path"]?.stringValue,
      event.payload["item"]?["text"]?.stringValue,
      contentText(in: event.payload["item"]?["content"]),
      event.payload["toolCall"]?["title"]?.stringValue,
      event.payload["title"]?.stringValue,
    ]
    return candidates
      .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
      .first(where: { !$0.isEmpty })
  }

  /// Provider deltas are fragments, not standalone strings. Leading spaces and
  /// newlines are meaningful and must survive projection so `"What"` followed
  /// by `" now?"` does not become `"Whatnow?"`.
  private static func streamingText(for event: AgentEvent) -> String? {
    [
      event.payload["text"]?.stringValue,
      event.payload["message"]?.stringValue,
      event.payload["item"]?["text"]?.stringValue,
    ]
    .compactMap { $0 }
    .first(where: { !$0.isEmpty })
  }

  private static func contentText(in value: JSONValue?) -> String? {
    let text = value?.arrayValue?
      .compactMap { $0["text"]?.stringValue }
      .filter { !$0.isEmpty }
      .joined(separator: "\n")
    return text?.isEmpty == false ? text : nil
  }

  private static func activityText(for event: AgentEvent) -> String {
    let item = event.payload["item"]
    let command =
      item?["command"]?.stringValue
      ?? event.payload["command"]?.stringValue
      ?? stringArray(event.payload["command"])
      ?? stringArray(item?["command"])
    let path =
      item?["path"]?.stringValue
      ?? event.payload["path"]?.stringValue
    let title =
      item?["title"]?.stringValue
      ?? event.payload["toolCall"]?["title"]?.stringValue
      ?? event.payload["title"]?.stringValue
      ?? event.payload["name"]?.stringValue
    return [command, path, title]
      .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
      .first(where: { !$0.isEmpty }) ?? ""
  }

  private static func activityTitle(for event: AgentEvent) -> String {
    let type = providerItemType(in: event)
    let completed = event.kind == .toolCompleted
    return switch type {
    case "commandExecution":
      completed ? "Command completed" : "Running command"
    case "fileChange":
      completed ? "Files changed" : "Changing files"
    case "webSearch":
      completed ? "Search completed" : "Searching the web"
    case "mcpToolCall":
      completed ? "Tool completed" : "Using tool"
    default:
      switch event.kind {
      case .command: "Running command"
      case .fileChange: "Files changed"
      case .toolCompleted: "Tool completed"
      default: "Using tool"
      }
    }
  }

  private static func noticeTitle(for kind: AgentEventKind) -> String {
    switch kind {
    case .approvalRequested: "Approval requested"
    case .inputRequested: "Input requested"
    default: "Needs attention"
    }
  }

  private static func providerItemType(in event: AgentEvent) -> String? {
    event.payload["item"]?["type"]?.stringValue
      ?? event.payload["type"]?.stringValue
  }

  private static func providerItemID(in event: AgentEvent) -> String? {
    event.payload["item"]?["id"]?.stringValue
      ?? event.payload["toolCall"]?["toolCallId"]?.stringValue
      ?? event.payload["toolCallId"]?.stringValue
      ?? event.payload["id"]?.stringValue
  }

  private static func stringArray(_ value: JSONValue?) -> String? {
    let strings = value?.arrayValue?.compactMap(\.stringValue) ?? []
    return strings.isEmpty ? nil : strings.joined(separator: " ")
  }

  private static func appendDelta(_ delta: String, to existing: String) -> String {
    if delta == existing || existing.hasSuffix(delta) {
      return existing
    }
    if delta.hasPrefix(existing) {
      return delta
    }
    return existing + delta
  }

  private static func messagesRepresentSameResponse(
    _ streamed: String,
    _ final: String
  ) -> Bool {
    let streamed = normalized(streamed)
    let final = normalized(final)
    return streamed == final
      || final.hasPrefix(streamed)
      || streamed.hasPrefix(final)
  }

  private static func preferredFinalText(streamed: String, final: String) -> String {
    normalized(final).count >= normalized(streamed).count ? final : streamed
  }

  private static func normalized(_ value: String) -> String {
    value.split(whereSeparator: \.isWhitespace).joined(separator: " ")
  }

  private static func eventOrder(_ lhs: AgentEvent, _ rhs: AgentEvent) -> Bool {
    if lhs.sequence != rhs.sequence {
      return lhs.sequence < rhs.sequence
    }
    return lhs.timestamp < rhs.timestamp
  }
}
