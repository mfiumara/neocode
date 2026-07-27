import Foundation
import GRDB

public actor AppDatabase {
  private let writer: any DatabaseWriter
  private let encoder = JSONEncoder.orchestrator
  private let decoder = JSONDecoder.orchestrator

  public init(path: String) throws {
    var configuration = Configuration()
    configuration.busyMode = .timeout(5)
    configuration.foreignKeysEnabled = true
    let pool = try DatabasePool(path: path, configuration: configuration)
    writer = pool
    try Self.makeMigrator().migrate(pool)
  }

  public init(inMemory: Bool) throws {
    var configuration = Configuration()
    configuration.foreignKeysEnabled = true
    let queue = try DatabaseQueue(configuration: configuration)
    writer = queue
    try Self.makeMigrator().migrate(queue)
  }

  private static func makeMigrator() -> DatabaseMigrator {
    var migrator = DatabaseMigrator()
    migrator.registerMigration("v1") { db in
      try db.create(table: "projects") { table in
        table.column("id", .text).primaryKey()
        table.column("rootPath", .text).notNull().unique()
        table.column("json", .blob).notNull()
      }

      try db.create(table: "tasks") { table in
        table.column("id", .text).primaryKey()
        table.column("projectID", .text).notNull().indexed()
          .references("projects", onDelete: .cascade)
        table.column("status", .text).notNull().indexed()
        table.column("json", .blob).notNull()
      }

      try db.create(table: "workspaces") { table in
        table.column("id", .text).primaryKey()
        table.column("taskID", .text).notNull().indexed()
          .references("tasks", onDelete: .cascade)
        table.column("json", .blob).notNull()
      }

      try db.create(table: "agents") { table in
        table.column("id", .text).primaryKey()
        table.column("taskID", .text).notNull().indexed()
          .references("tasks", onDelete: .cascade)
        table.column("parentID", .text).indexed()
        table.column("status", .text).notNull().indexed()
        table.column("json", .blob).notNull()
      }

      try db.create(table: "agentEvents") { table in
        table.autoIncrementedPrimaryKey("sequence")
        table.column("id", .text).notNull().unique()
        table.column("taskID", .text).notNull().indexed()
          .references("tasks", onDelete: .cascade)
        table.column("agentID", .text).indexed()
        table.column("kind", .text).notNull().indexed()
        table.column("timestamp", .datetime).notNull().indexed()
        table.column("json", .blob).notNull()
      }

      try db.create(table: "approvals") { table in
        table.column("id", .text).primaryKey()
        table.column("taskID", .text).notNull().indexed()
          .references("tasks", onDelete: .cascade)
        table.column("status", .text).notNull().indexed()
        table.column("json", .blob).notNull()
      }

      try db.create(table: "terminals") { table in
        table.column("id", .text).primaryKey()
        table.column("taskID", .text).notNull().indexed()
          .references("tasks", onDelete: .cascade)
        table.column("json", .blob).notNull()
      }

      try db.create(table: "services") { table in
        table.column("id", .text).primaryKey()
        table.column("taskID", .text).notNull().indexed()
          .references("tasks", onDelete: .cascade)
        table.column("json", .blob).notNull()
      }

      try db.create(table: "panelLayouts") { table in
        table.column("id", .text).primaryKey()
        table.column("projectID", .text).notNull().indexed()
          .references("projects", onDelete: .cascade)
        table.column("json", .blob).notNull()
      }

      try db.create(table: "pullRequests") { table in
        table.column("id", .text).primaryKey()
        table.column("taskID", .text).notNull().indexed()
          .references("tasks", onDelete: .cascade)
        table.column("json", .blob).notNull()
      }

      try db.create(table: "requestLog") { table in
        table.column("requestID", .text).primaryKey()
        table.column("result", .blob).notNull()
        table.column("createdAt", .datetime).notNull()
      }

      try db.create(table: "trustedConfigurations") { table in
        table.column("projectID", .text).notNull()
        table.column("hash", .text).notNull()
        table.column("trustedAt", .datetime).notNull()
        table.primaryKey(["projectID", "hash"])
      }
    }
    migrator.registerMigration("v2-input-requests") { db in
      try db.create(table: "inputRequests") { table in
        table.column("id", .text).primaryKey()
        table.column("taskID", .text).notNull().indexed()
          .references("tasks", onDelete: .cascade)
        table.column("status", .text).notNull().indexed()
        table.column("json", .blob).notNull()
      }
    }
    return migrator
  }

  public func upsert(_ project: Project) throws {
    try upsert(
      table: "projects",
      id: project.id,
      indexes: ["rootPath": project.rootPath],
      value: project
    )
  }

  public func upsert(_ task: OrchestrationTask) throws {
    try upsert(
      table: "tasks",
      id: task.id,
      indexes: ["projectID": task.projectID, "status": task.status.rawValue],
      value: task
    )
  }

  public func upsert(_ workspace: Workspace) throws {
    try upsert(
      table: "workspaces",
      id: workspace.id,
      indexes: ["taskID": workspace.taskID],
      value: workspace
    )
  }

  public func upsert(_ agent: AgentSession) throws {
    var indexes = [
      "taskID": agent.taskID,
      "status": agent.status.rawValue,
    ]
    indexes["parentID"] = agent.parentID
    try upsert(table: "agents", id: agent.id, indexes: indexes, value: agent)
  }

  public func upsert(_ approval: Approval) throws {
    try upsert(
      table: "approvals",
      id: approval.id,
      indexes: ["taskID": approval.taskID, "status": approval.status.rawValue],
      value: approval
    )
  }

  public func upsert(_ inputRequest: AgentInputRequest) throws {
    try upsert(
      table: "inputRequests",
      id: inputRequest.id,
      indexes: [
        "taskID": inputRequest.taskID,
        "status": inputRequest.status.rawValue,
      ],
      value: inputRequest
    )
  }

  public func upsert(_ terminal: TerminalSession) throws {
    try upsert(
      table: "terminals",
      id: terminal.id,
      indexes: ["taskID": terminal.taskID],
      value: terminal
    )
  }

  public func upsert(_ service: ManagedService) throws {
    try upsert(
      table: "services",
      id: service.id,
      indexes: ["taskID": service.taskID],
      value: service
    )
  }

  public func upsert(_ layout: PanelLayout) throws {
    try upsert(
      table: "panelLayouts",
      id: layout.id,
      indexes: ["projectID": layout.projectID],
      value: layout
    )
  }

  public func upsert(_ pullRequest: PullRequest) throws {
    try upsert(
      table: "pullRequests",
      id: pullRequest.id,
      indexes: ["taskID": pullRequest.taskID],
      value: pullRequest
    )
  }

  @discardableResult
  public func append(_ event: AgentEvent) throws -> AgentEvent {
    let data = try encoder.encode(event)
    let sequence = try writer.write { db -> Int64 in
      try db.execute(
        sql: """
          INSERT INTO agentEvents (id, taskID, agentID, kind, timestamp, json)
          VALUES (?, ?, ?, ?, ?, ?)
          """,
        arguments: [
          event.id,
          event.taskID,
          event.agentID,
          event.kind.rawValue,
          event.timestamp,
          data,
        ]
      )
      return db.lastInsertedRowID
    }
    var stored = event
    stored.sequence = sequence
    return stored
  }

  public func events(
    after sequence: Int64 = 0,
    taskID: String? = nil,
    limit: Int = 10_000
  ) throws -> [AgentEvent] {
    try writer.read { db in
      let rows: [Row]
      if let taskID {
        rows = try Row.fetchAll(
          db,
          sql: """
            SELECT sequence, json FROM agentEvents
            WHERE sequence > ? AND taskID = ?
            ORDER BY sequence ASC LIMIT ?
            """,
          arguments: [sequence, taskID, limit]
        )
      } else {
        rows = try Row.fetchAll(
          db,
          sql: """
            SELECT sequence, json FROM agentEvents
            WHERE sequence > ?
            ORDER BY sequence ASC LIMIT ?
            """,
          arguments: [sequence, limit]
        )
      }

      return try rows.map { row in
        let data: Data = row["json"]
        var event = try decoder.decode(AgentEvent.self, from: data)
        event.sequence = row["sequence"]
        return event
      }
    }
  }

  public func snapshot(projectID: String) throws -> CoreSnapshot {
    try writer.read { db in
      let project = try decodeOne(
        Project.self,
        db: db,
        sql: "SELECT json FROM projects WHERE id = ?",
        arguments: [projectID]
      )
      let tasks = try decodeAll(
        OrchestrationTask.self,
        db: db,
        sql: "SELECT json FROM tasks WHERE projectID = ? ORDER BY rowid DESC",
        arguments: [projectID]
      )
      let taskIDs = Set(tasks.map(\.id))
      let workspaces = try decodeAll(Workspace.self, db: db, table: "workspaces")
        .filter { taskIDs.contains($0.taskID) }
      let agents = try decodeAll(AgentSession.self, db: db, table: "agents")
        .filter { taskIDs.contains($0.taskID) }
      let approvals = try decodeAll(Approval.self, db: db, table: "approvals")
        .filter { taskIDs.contains($0.taskID) }
      let inputRequests = try decodeAll(
        AgentInputRequest.self,
        db: db,
        table: "inputRequests"
      )
      .filter { taskIDs.contains($0.taskID) }
      let terminals = try decodeAll(TerminalSession.self, db: db, table: "terminals")
        .filter { taskIDs.contains($0.taskID) }
      let services = try decodeAll(ManagedService.self, db: db, table: "services")
        .filter { taskIDs.contains($0.taskID) }
      let layouts = try decodeAll(
        PanelLayout.self,
        db: db,
        sql: "SELECT json FROM panelLayouts WHERE projectID = ?",
        arguments: [projectID]
      )
      let pullRequests = try decodeAll(PullRequest.self, db: db, table: "pullRequests")
        .filter { taskIDs.contains($0.taskID) }
      let latestSequence =
        try Int64.fetchOne(
          db,
          sql: "SELECT MAX(sequence) FROM agentEvents"
        ) ?? 0

      return CoreSnapshot(
        project: project,
        tasks: tasks,
        workspaces: workspaces,
        agents: agents,
        approvals: approvals,
        inputRequests: inputRequests,
        terminals: terminals,
        services: services,
        layouts: layouts,
        pullRequests: pullRequests,
        latestSequence: latestSequence
      )
    }
  }

  public func allProjects() throws -> [Project] {
    try writer.read { db in
      try decodeAll(
        Project.self,
        db: db,
        sql: "SELECT json FROM projects ORDER BY rowid DESC",
        arguments: []
      )
    }
  }

  public func deleteTask(id: String) throws {
    try writer.write { db in
      try db.execute(sql: "DELETE FROM tasks WHERE id = ?", arguments: [id])
    }
  }

  public func storedResult<T: Decodable>(
    for requestID: String,
    as type: T.Type
  ) throws -> T? {
    try writer.read { db in
      guard
        let data = try Data.fetchOne(
          db,
          sql: "SELECT result FROM requestLog WHERE requestID = ?",
          arguments: [requestID]
        )
      else {
        return nil
      }
      return try decoder.decode(type, from: data)
    }
  }

  public func storeResult<T: Encodable>(_ result: T, for requestID: String) throws {
    let data = try encoder.encode(result)
    try writer.write { db in
      try db.execute(
        sql: """
          INSERT OR IGNORE INTO requestLog (requestID, result, createdAt)
          VALUES (?, ?, ?)
          """,
        arguments: [requestID, data, Date.now]
      )
    }
  }

  public func trustConfiguration(projectID: String, hash: String) throws {
    try writer.write { db in
      try db.execute(
        sql: """
          INSERT OR REPLACE INTO trustedConfigurations (projectID, hash, trustedAt)
          VALUES (?, ?, ?)
          """,
        arguments: [projectID, hash, Date.now]
      )
    }
  }

  public func isConfigurationTrusted(projectID: String, hash: String) throws -> Bool {
    try writer.read { db in
      try Bool.fetchOne(
        db,
        sql: """
          SELECT EXISTS(
              SELECT 1 FROM trustedConfigurations
              WHERE projectID = ? AND hash = ?
          )
          """,
        arguments: [projectID, hash]
      ) ?? false
    }
  }

  private func upsert<T: Encodable>(
    table: String,
    id: String,
    indexes: [String: String?],
    value: T
  ) throws {
    let data = try encoder.encode(value)
    let columns = ["id"] + indexes.keys.sorted() + ["json"]
    let placeholders = Array(repeating: "?", count: columns.count).joined(separator: ", ")
    let update =
      columns
      .filter { $0 != "id" }
      .map { "\($0) = excluded.\($0)" }
      .joined(separator: ", ")
    var arguments: [DatabaseValueConvertible?] = [id]
    for key in indexes.keys.sorted() {
      arguments.append(indexes[key] ?? nil)
    }
    arguments.append(data)

    try writer.write { db in
      try db.execute(
        sql: """
          INSERT INTO \(table) (\(columns.joined(separator: ", ")))
          VALUES (\(placeholders))
          ON CONFLICT(id) DO UPDATE SET \(update)
          """,
        arguments: StatementArguments(arguments)
      )
    }
  }

  private func decodeAll<T: Decodable>(
    _ type: T.Type,
    db: Database,
    table: String
  ) throws -> [T] {
    try decodeAll(type, db: db, sql: "SELECT json FROM \(table)", arguments: [])
  }

  private func decodeAll<T: Decodable>(
    _ type: T.Type,
    db: Database,
    sql: String,
    arguments: StatementArguments
  ) throws -> [T] {
    try Row.fetchAll(db, sql: sql, arguments: arguments).map { row in
      let data: Data = row["json"]
      return try decoder.decode(type, from: data)
    }
  }

  private func decodeOne<T: Decodable>(
    _ type: T.Type,
    db: Database,
    sql: String,
    arguments: StatementArguments
  ) throws -> T? {
    guard let row = try Row.fetchOne(db, sql: sql, arguments: arguments) else {
      return nil
    }
    let data: Data = row["json"]
    return try decoder.decode(type, from: data)
  }
}
