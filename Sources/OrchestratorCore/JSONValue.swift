import Foundation

/// A lossless JSON value used at provider and persistence boundaries.
public enum JSONValue: Codable, Sendable, Equatable, Hashable {
  case null
  case bool(Bool)
  case number(Double)
  case string(String)
  case array([JSONValue])
  case object([String: JSONValue])

  public init(from decoder: Decoder) throws {
    let container = try decoder.singleValueContainer()
    if container.decodeNil() {
      self = .null
    } else if let value = try? container.decode(Bool.self) {
      self = .bool(value)
    } else if let value = try? container.decode(Double.self) {
      self = .number(value)
    } else if let value = try? container.decode(String.self) {
      self = .string(value)
    } else if let value = try? container.decode([JSONValue].self) {
      self = .array(value)
    } else {
      self = .object(try container.decode([String: JSONValue].self))
    }
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer()
    switch self {
    case .null:
      try container.encodeNil()
    case .bool(let value):
      try container.encode(value)
    case .number(let value):
      try container.encode(value)
    case .string(let value):
      try container.encode(value)
    case .array(let value):
      try container.encode(value)
    case .object(let value):
      try container.encode(value)
    }
  }

  public subscript(key: String) -> JSONValue? {
    guard case .object(let object) = self else { return nil }
    return object[key]
  }

  public var stringValue: String? {
    guard case .string(let value) = self else { return nil }
    return value
  }

  public var objectValue: [String: JSONValue]? {
    guard case .object(let value) = self else { return nil }
    return value
  }

  public var arrayValue: [JSONValue]? {
    guard case .array(let value) = self else { return nil }
    return value
  }

  public static func encode<T: Encodable>(_ value: T) throws -> JSONValue {
    let data = try JSONEncoder.orchestrator.encode(value)
    return try JSONDecoder.orchestrator.decode(JSONValue.self, from: data)
  }

  public func decode<T: Decodable>(_ type: T.Type) throws -> T {
    let data = try JSONEncoder.orchestrator.encode(self)
    return try JSONDecoder.orchestrator.decode(type, from: data)
  }
}

extension JSONEncoder {
  public static var orchestrator: JSONEncoder {
    let encoder = JSONEncoder()
    // Encode the IEEE-754 payload as hex so an event replay preserves the
    // exact Date value, including sub-millisecond precision.
    encoder.dateEncodingStrategy = .custom { date, encoder in
      var container = encoder.singleValueContainer()
      try container.encode(
        String(date.timeIntervalSinceReferenceDate.bitPattern, radix: 16)
      )
    }
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    return encoder
  }
}

extension JSONDecoder {
  public static var orchestrator: JSONDecoder {
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .custom { decoder in
      let container = try decoder.singleValueContainer()
      if let value = try? container.decode(String.self),
        let bits = UInt64(value, radix: 16)
      {
        return Date(
          timeIntervalSinceReferenceDate: Double(bitPattern: bits)
        )
      }
      // Compatibility with the earliest alpha database codec.
      return Date(
        timeIntervalSince1970: try container.decode(Double.self)
      )
    }
    return decoder
  }
}
