/*
 * This file is part of Cockpit.
 *
 * Copyright (C) 2017 Red Hat, Inc.
 *
 * Cockpit is free software; you can redistribute it and/or modify it
 * under the terms of the GNU Lesser General Public License as published by
 * the Free Software Foundation; either version 2.1 of the License, or
 * (at your option) any later version.
 *
 * Cockpit is distributed in the hope that it will be useful, but
 * WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public License
 * along with Cockpit; If not, see <http://www.gnu.org/licenses/>.
 */
import { Alert } from "@patternfly/react-core/dist/esm/components/Alert/index.js";
import { Card, CardBody, CardTitle } from "@patternfly/react-core/dist/esm/components/Card/index.js";
import cockpit from "cockpit";
import React, {
    FormEvent,
    useCallback,
    useEffect,
    useMemo,
    useState,
} from "react";

const _ = cockpit.gettext;
const DRIVER = "mysql";

function run(cmd: string, args: string[] = []) {
    const helper = "/usr/local/libexec/cockpit-apache-helper";
    const printable = [helper, cmd, ...args].map(
        (value) => `"${String(value).replace(/"/g, '\\"')}"`
    );
    console.debug("spawning:", printable.join(" "));
    return cockpit
        .spawn([helper, cmd, ...args], {
            superuser: "try",
            err: "message",
        })
        .then((out) => out);
}

const encodeQuery = (value: string) =>
    window.btoa(
        encodeURIComponent(value).replace(/%([0-9A-F]{2})/g, (_, hex) =>
            String.fromCharCode(parseInt(hex, 16))
        )
    );

const escapeIdentifier = (value: string) =>
    `\`${value.replace(/`/g, "``")}\``;

const escapeSqlString = (value: string) =>
    `'${value.replace(/'/g, "''")}'`;

type QueryResult = {
    columns: string[];
    rows: Array<Array<string | number | null>>;
    rowCount: number;
    message?: string;
};

type DatabaseSummary = {
    name: string;
    tables?: number;
    sizeBytes?: number;
};

type UserSummary = {
    name: string;
    host: string;
    plugin?: string;
};

type TableSummary = {
    name: string;
    rows?: number;
    engine?: string;
    sizeBytes?: number;
    collation?: string;
};

type Connection = {
    host: string;
    port: string;
    user: string;
    password: string;
    database: string;
};

const DEFAULT_CONNECTION: Connection = {
    host: "localhost",
    port: "3306",
    user: "cockpit",
    password: "cockpit",
    database: "",
};

const fieldStyle: React.CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: 4,
};

const inputStyle: React.CSSProperties = {
    borderRadius: 6,
    border: "1px solid var(--pf-global--BorderColor--100, #d2d2d2)",
    padding: "8px 10px",
    fontSize: 14,
    width: "100%",
};

const buttonStyle: React.CSSProperties = {
    borderRadius: 6,
    border: "none",
    padding: "8px 14px",
    cursor: "pointer",
    background: "var(--pf-global--palette--blue-400, #06c)",
    color: "#fff",
    fontWeight: 600,
};

const panelStyle: React.CSSProperties = {
    // background: "var(--pf-global--BackgroundColor--100, #fff)",
    borderRadius: 12,
    border: "1px solid var(--pf-global--BorderColor--100, #d2d2d2)",
    padding: 16,
    boxShadow: "0 4px 12px rgba(3,3,3,.08)",
};

const describeError = (err: unknown) => {
    if (err instanceof Error) return err.message;
    if (typeof err === "string") return err;
    try {
        return JSON.stringify(err);
    } catch (error) {
        return _("Unknown error");
    }
};

const formatBytes = (bytes?: number) => {
    if (bytes === undefined || bytes === null) return "";
    if (bytes === 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB", "PB"];
    const power = Math.min(
        units.length - 1,
        Math.floor(Math.log(bytes) / Math.log(1024))
    );
    const value = bytes / Math.pow(1024, power);
    return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[power]}`;
};

const Application = () => {
    const [connection, setConnection] = useState<Connection>(DEFAULT_CONNECTION);
    const [connecting, setConnecting] = useState(false);
    const [connected, setConnected] = useState(false);
    const [statusMessage, setStatusMessage] = useState("");
    const [errorMessage, setErrorMessage] = useState<string | null>(null);
    const [databases, setDatabases] = useState<DatabaseSummary[]>([]);
    const [users, setUsers] = useState<UserSummary[]>([]);
    const [tables, setTables] = useState<TableSummary[]>([]);
    const [tablesLoading, setTablesLoading] = useState(false);
    const [tablesError, setTablesError] = useState<string | null>(null);
    const [newDbName, setNewDbName] = useState("");
    const [newDbCharset, setNewDbCharset] = useState("utf8mb4");
    const [newUser, setNewUser] = useState({
        name: "",
        host: "%",
        password: "",
        privileges: "ALL PRIVILEGES",
        db: "*.*",
    });
    const [actionMessage, setActionMessage] = useState<string | null>(null);
    const [queryText, setQueryText] = useState("SHOW DATABASES;");
    const [queryResult, setQueryResult] = useState<QueryResult | null>(null);
    const [queryBusy, setQueryBusy] = useState(false);

    const normalizedHost = connection.host.trim() || "localhost";
    const normalizedPort = connection.port.trim() || "3306";

    const runQuery = useCallback(
        async (sql: string, databaseOverride?: string) => {
            const args = [
                DRIVER,
                normalizedHost,
                normalizedPort,
                connection.user || "",
                connection.password || "",
                databaseOverride !== undefined
                    ? databaseOverride
                    : connection.database || "",
                encodeQuery(sql),
            ];
            console.log("running query:", sql);
            const raw = await run("db-query", args);
            return JSON.parse(raw) as QueryResult;
        },
        [connection.database, connection.password, connection.user, normalizedHost, normalizedPort]
    );

    const loadDatabases = useCallback(async () => {
        const list = await runQuery("SHOW DATABASES", "");
        const names = list.rows.map((row) => row[0] as string);
        const stats = await runQuery(
            [
                "SELECT table_schema, COUNT(*) AS table_count,",
                "COALESCE(SUM(data_length + index_length), 0) AS total_size",
                "FROM information_schema.tables",
                "GROUP BY table_schema",
            ].join(" "),
            "information_schema"
        );
        const statsMap = new Map(
            stats.rows.map((row) => [
                row[0] as string,
                {
                    tables: Number(row[1]) || 0,
                    sizeBytes: Number(row[2]) || 0,
                },
            ])
        );
        setDatabases(
            names.map((name) => ({
                name,
                tables: statsMap.get(name)?.tables ?? 0,
                sizeBytes: statsMap.get(name)?.sizeBytes ?? 0,
            }))
        );
    }, [runQuery]);

    const loadUsers = useCallback(async () => {
        const result = await runQuery(
            "SELECT user, host, plugin FROM mysql.user ORDER BY user, host",
            "mysql"
        );
        setUsers(
            result.rows.map((row) => ({
                name: String(row[0] ?? ""),
                host: String(row[1] ?? ""),
                plugin: row[2] ? String(row[2]) : undefined,
            }))
        );
    }, [runQuery]);

    const loadTables = useCallback(
        async (database: string) => {
            if (!database) {
                setTables([]);
                return;
            }
            setTablesLoading(true);
            setTablesError(null);
            try {
                const sql = [
                    "SELECT table_name, engine, table_rows,",
                    "data_length + index_length AS size, table_collation",
                    "FROM information_schema.tables",
                    "WHERE table_schema = " + escapeSqlString(database),
                    "ORDER BY table_name",
                ].join(" ");
                const payload = await runQuery(sql, "information_schema");
                setTables(
                    payload.rows.map((row) => ({
                        name: String(row[0] ?? ""),
                        engine: row[1] ? String(row[1]) : undefined,
                        rows: row[2] !== null ? Number(row[2]) : undefined,
                        sizeBytes: row[3] !== null ? Number(row[3]) : undefined,
                        collation: row[4] ? String(row[4]) : undefined,
                    }))
                );
            } catch (error) {
                setTables([]);
                setTablesError(describeError(error));
            } finally {
                setTablesLoading(false);
            }
        },
        [runQuery]
    );

    useEffect(() => {
        if (connected) {
            if (connection.database) {
                loadTables(connection.database);
            } else {
                setTables([]);
            }
        }
    }, [connected, connection.database, loadTables]);

    const connect = async (event: FormEvent) => {
        console.log("connecting to", connection);
        event.preventDefault();
        setConnecting(true);
        setErrorMessage(null);
        setStatusMessage(_("Connecting…"));
        try {
            const result = await runQuery("SELECT 1");
            setConnected(true);
            setStatusMessage(_("Connected."));
            await Promise.all([loadDatabases(), loadUsers()]);
        } catch (error) {
            setConnected(false);
            setStatusMessage("");
            setErrorMessage(describeError(error));
        } finally {
            setConnecting(false);
        }
    };

    const disconnect = () => {
        setConnected(false);
        setStatusMessage(_("Disconnected."));
        setDatabases([]);
        setUsers([]);
        setTables([]);
        setQueryResult(null);
    };

    const refreshAll = async () => {
        if (!connected) return;
        setStatusMessage(_("Refreshing…"));
        try {
            await Promise.all([
                loadDatabases(),
                loadUsers(),
                connection.database ? loadTables(connection.database) : Promise.resolve(),
            ]);
            setStatusMessage(_("Data refreshed."));
        } catch (error) {
            setStatusMessage("");
            setErrorMessage(describeError(error));
        }
    };

    const sanitizeCharset = (value: string) => {
        const normalized = value.trim() || "utf8mb4";
        if (!/^[A-Za-z0-9_]+$/.test(normalized)) {
            throw new Error(_("Charset may only contain letters, digits, or underscore."));
        }
        return normalized;
    };

    const handleCreateDatabase = async (event: FormEvent) => {
        event.preventDefault();
        if (!connected) return;
        const name = newDbName.trim();
        if (!name) {
            setActionMessage(_("Database name is required."));
            return;
        }
        try {
            const charset = sanitizeCharset(newDbCharset);
            const sql = `CREATE DATABASE ${escapeIdentifier(name)} CHARACTER SET ${charset}`;
            await runQuery(sql);
            setActionMessage(_("Database created."));
            setNewDbName("");
            await loadDatabases();
        } catch (error) {
            setActionMessage(describeError(error));
        }
    };

    const dropDatabase = async (name: string) => {
        if (!connected) return;
        if (!window.confirm(cockpit.format(_("Drop database $0?"), name))) return;
        try {
            await runQuery(`DROP DATABASE ${escapeIdentifier(name)}`);
            setActionMessage(_("Database removed."));
            if (connection.database === name) {
                setConnection((prev) => ({ ...prev, database: "" }));
            }
            await loadDatabases();
        } catch (error) {
            setActionMessage(describeError(error));
        }
    };

    const handleCreateUser = async (event: FormEvent) => {
        event.preventDefault();
        if (!connected) return;
        if (!newUser.name.trim()) {
            setActionMessage(_("User name is required."));
            return;
        }
        if (!newUser.password) {
            setActionMessage(_("Password is required."));
            return;
        }
        try {
            const username = escapeSqlString(newUser.name.trim());
            const host = escapeSqlString(newUser.host.trim() || "%");
            const identifier = `${username}@${host}`;
            const privileges = newUser.privileges.trim() || "ALL PRIVILEGES";
            const dbPattern = newUser.db.trim() || "*.*";
            const statements = [
                `CREATE USER ${identifier} IDENTIFIED BY ${escapeSqlString(newUser.password)}`,
                `GRANT ${privileges} ON ${dbPattern} TO ${identifier}`,
                "FLUSH PRIVILEGES",
            ];
            await runQuery(statements.join("; "));
            setActionMessage(_("User created."));
            setNewUser({
                name: "",
                host: "%",
                password: "",
                privileges: "ALL PRIVILEGES",
                db: "*.*",
            });
            await loadUsers();
        } catch (error) {
            setActionMessage(describeError(error));
        }
    };

    const dropUser = async (user: UserSummary) => {
        if (!connected) return;
        if (
            !window.confirm(
                cockpit.format(_("Remove $0@$1?"), user.name, user.host || "%")
            )
        )
            return;
        try {
            const identifier = `${escapeSqlString(user.name)}@${escapeSqlString(user.host)}`;
            await runQuery(`DROP USER ${identifier}`);
            setActionMessage(_("User removed."));
            await loadUsers();
        } catch (error) {
            setActionMessage(describeError(error));
        }
    };

    const handleRunQuery = async (event: FormEvent) => {
        event.preventDefault();
        if (!connected || !queryText.trim()) return;
        setQueryBusy(true);
        setActionMessage(null);
        try {
            const result = await runQuery(queryText, connection.database || undefined);
            console.log(result);
            setQueryResult(result);
            setActionMessage(result.message || _("Query completed."));
        } catch (error) {
            setQueryResult(null);
            setActionMessage(describeError(error));
        } finally {
            setQueryBusy(false);
        }
    };

    const currentDatabase = useMemo(
        () => databases.find((db) => db.name === connection.database) ?? null,
        [databases, connection.database]
    );

    if (!connected) {
        return (
            <Card>
                <CardTitle
                    style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                    }}
                >
                    <span>{_("Adminer Manager")}</span>
                    <span style={{ marginTop: 0, color: "#6a6e73" }}>
                        {_("Connect to a MySQL instance to inspect databases, users, and tables.")}
                    </span>
                </CardTitle>
                <CardBody>
                    {/* <div
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "var(--pf-global--BackgroundColor--200, #f0f0f0)",
          padding: 24,
        }}
      > */}
                    <form onSubmit={connect} style={{ ...panelStyle, width: 420 }}>
                        {/* <h1 style={{ marginTop: 0, marginBottom: 4 }}>{_("MySQL Manager")}</h1> */}
                        <div style={{ display: "grid", gap: 12 }}>
                            <div style={fieldStyle}>
                                <label htmlFor="mysql-host">{_("Host")}</label>
                                <input
                                    id="mysql-host"
                                    style={inputStyle}
                                    value={connection.host}
                                    onChange={(event) =>
                                        setConnection((prev) => ({ ...prev, host: event.target.value }))
                                    }
                                />
                            </div>
                            <div style={fieldStyle}>
                                <label htmlFor="mysql-port">{_("Port")}</label>
                                <input
                                    id="mysql-port"
                                    style={inputStyle}
                                    value={connection.port}
                                    onChange={(event) =>
                                        setConnection((prev) => ({ ...prev, port: event.target.value }))
                                    }
                                />
                            </div>
                            <div style={fieldStyle}>
                                <label htmlFor="mysql-user">{_("Username")}</label>
                                <input
                                    id="mysql-user"
                                    style={inputStyle}
                                    value={connection.user}
                                    onChange={(event) =>
                                        setConnection((prev) => ({ ...prev, user: event.target.value }))
                                    }
                                    autoComplete="username"
                                />
                            </div>
                            <div style={fieldStyle}>
                                <label htmlFor="mysql-password">{_("Password")}</label>
                                <input
                                    id="mysql-password"
                                    style={inputStyle}
                                    type="password"
                                    value={connection.password}
                                    onChange={(event) =>
                                        setConnection((prev) => ({ ...prev, password: event.target.value }))
                                    }
                                    autoComplete="current-password"
                                />
                            </div>
                            <div style={fieldStyle}>
                                <label htmlFor="mysql-db">{_("Default database (optional)")}</label>
                                <input
                                    id="mysql-db"
                                    style={inputStyle}
                                    value={connection.database}
                                    onChange={(event) =>
                                        setConnection((prev) => ({ ...prev, database: event.target.value }))
                                    }
                                />
                            </div>
                            {errorMessage && (
                                <div style={{ color: "var(--pf-global--palette--red-600, #c9190b)" }}>
                                    {errorMessage}
                                </div>
                            )}
                            <button
                                type="submit"
                                style={{ ...buttonStyle, width: "100%" }}
                                disabled={connecting}
                            >
                                {connecting ? _("Connecting…") : _("Connect")}
                            </button>
                        </div>
                    </form>
                    {/* </div> */}
                </CardBody>
            </Card>
        );
    }

    return (
        <Card>
            <CardTitle>
                {_("Adminer Manager")}
            </CardTitle>
            <CardBody style={{ display: "flex", flexDirection: "column", gap: 16, overflowY: "auto", height: "80vh" }}>
            <Alert
                title={cockpit.format(
                    _("Connected as $0@$1:$2"),
                    connection.user || _("(anonymous)"),
                    normalizedHost,
                    normalizedPort
                )} variant={errorMessage ? "danger" : "info"} isInline
            >
                {!errorMessage && !actionMessage && statusMessage && <div style={{ fontSize: 13 }}>{statusMessage}</div>}
                {!actionMessage && errorMessage && <div style={{ fontSize: 13 }}>{errorMessage}</div>}
                {actionMessage && <div style={{ fontSize: 13 }}>{actionMessage}</div>}

            </Alert>
                {/* <div
      style={{
        padding: 24,
        background: "var(--pf-global--BackgroundColor--200, #f0f0f0)",
        minHeight: "100vh",
        fontFamily:
          "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        color: "var(--pf-global--Color--100, #151515)",
      }}
    > */}
                <div style={{ ...panelStyle, display: "flex", flexDirection: "column", gap: 16 }}>
                    <header style={{ display: "flex", justifyContent: "space-between", gap: 16 }}>
                        {/* <div>
                            <h1 style={{ margin: 0 }}>{_("MySQL Manager")}</h1>
                        </div> */}
                        <div style={{ display: "flex", gap: 8 }}>
                            <button
                                style={{
                                    ...buttonStyle,
                                    background: "var(--pf-global--palette--green-500, #38812f)",
                                }}
                                onClick={refreshAll}
                            >
                                {_("Refresh")}
                            </button>
                            <button
                                style={{
                                    ...buttonStyle,
                                    background: "var(--pf-global--palette--black-500, #6a6e73)",
                                }}
                                onClick={disconnect}
                            >
                                {_("Disconnect")}
                            </button>
                        </div>
                    </header>

                    <section style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
                        <div style={{ ...panelStyle, padding: 12 }}>
                            <h2 style={{ marginTop: 0 }}>{_("Databases")}</h2>
                            <form
                                onSubmit={handleCreateDatabase}
                                style={{ display: "grid", gap: 8, marginBottom: 16 }}
                            >
                                <div style={fieldStyle}>
                                    <label htmlFor="new-db-name">{_("Create database")}</label>
                                    <input
                                        id="new-db-name"
                                        style={inputStyle}
                                        value={newDbName}
                                        onChange={(event) => setNewDbName(event.target.value)}
                                        placeholder="appdb"
                                    />
                                </div>
                                <div style={fieldStyle}>
                                    <label htmlFor="new-db-charset">{_("Charset")}</label>
                                    <input
                                        id="new-db-charset"
                                        style={inputStyle}
                                        value={newDbCharset}
                                        onChange={(event) => setNewDbCharset(event.target.value)}
                                    />
                                </div>
                                <button type="submit" style={buttonStyle}>
                                    {_("Create")}
                                </button>
                            </form>
                            <div style={{ maxHeight: 260, overflowY: "auto" }}>
                                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
                                    <thead>
                                        <tr style={{ textAlign: "left" }}>
                                            <th>{_("Name")}</th>
                                            <th>{_("Tables")}</th>
                                            <th>{_("Size")}</th>
                                            <th />
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {databases.map((db) => (
                                            <tr key={db.name} style={{ borderTop: "1px solid #d2d2d2" }}>
                                                <td>
                                                    <button
                                                        type="button"
                                                        onClick={() =>
                                                            setConnection((prev) => ({ ...prev, database: db.name }))
                                                        }
                                                        style={{
                                                            background: "none",
                                                            border: "none",
                                                            padding: 0,
                                                            cursor: "pointer",
                                                            color:
                                                                connection.database === db.name
                                                                    ? "var(--pf-global--palette--blue-500, #004080)"
                                                                    : "inherit",
                                                            fontWeight: connection.database === db.name ? 600 : 400,
                                                        }}
                                                    >
                                                        {db.name}
                                                    </button>
                                                </td>
                                                <td>{db.tables ?? "–"}</td>
                                                <td>{formatBytes(db.sizeBytes)}</td>
                                                <td>
                                                    <button
                                                        type="button"
                                                        onClick={() => dropDatabase(db.name)}
                                                        style={{
                                                            ...buttonStyle,
                                                            background: "var(--pf-global--palette--red-500, #c9190b)",
                                                            padding: "4px 8px",
                                                        }}
                                                    >
                                                        {_("Drop")}
                                                    </button>
                                                </td>
                                            </tr>
                                        ))}
                                        {databases.length === 0 && (
                                            <tr>
                                                <td colSpan={4} style={{ textAlign: "center", padding: 12 }}>
                                                    {_("No databases visible with current credentials.")}
                                                </td>
                                            </tr>
                                        )}
                                    </tbody>
                                </table>
                            </div>
                        </div>

                        <div style={{ ...panelStyle, padding: 12 }}>
                            <h2 style={{ marginTop: 0 }}>{_("Users")}</h2>
                            <form
                                onSubmit={handleCreateUser}
                                style={{ display: "grid", gap: 8, marginBottom: 16 }}
                            >
                                <div style={fieldStyle}>
                                    <label htmlFor="new-user-name">{_("Username")}</label>
                                    <input
                                        id="new-user-name"
                                        style={inputStyle}
                                        value={newUser.name}
                                        onChange={(event) =>
                                            setNewUser((prev) => ({ ...prev, name: event.target.value }))
                                        }
                                    />
                                </div>
                                <div style={fieldStyle}>
                                    <label htmlFor="new-user-host">{_("Host")}</label>
                                    <input
                                        id="new-user-host"
                                        style={inputStyle}
                                        value={newUser.host}
                                        onChange={(event) =>
                                            setNewUser((prev) => ({ ...prev, host: event.target.value }))
                                        }
                                    />
                                </div>
                                <div style={fieldStyle}>
                                    <label htmlFor="new-user-password">{_("Password")}</label>
                                    <input
                                        id="new-user-password"
                                        style={inputStyle}
                                        type="password"
                                        value={newUser.password}
                                        onChange={(event) =>
                                            setNewUser((prev) => ({ ...prev, password: event.target.value }))
                                        }
                                    />
                                </div>
                                <div style={fieldStyle}>
                                    <label htmlFor="new-user-db">{_("Grant on (e.g. db.*)")}</label>
                                    <input
                                        id="new-user-db"
                                        style={inputStyle}
                                        value={newUser.db}
                                        onChange={(event) =>
                                            setNewUser((prev) => ({ ...prev, db: event.target.value }))
                                        }
                                    />
                                </div>
                                <div style={fieldStyle}>
                                    <label htmlFor="new-user-privs">{_("Privileges clause")}</label>
                                    <input
                                        id="new-user-privs"
                                        style={inputStyle}
                                        value={newUser.privileges}
                                        onChange={(event) =>
                                            setNewUser((prev) => ({ ...prev, privileges: event.target.value }))
                                        }
                                    />
                                </div>
                                <button type="submit" style={buttonStyle}>
                                    {_("Create user")}
                                </button>
                            </form>
                            <div style={{ maxHeight: 260, overflowY: "auto" }}>
                                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
                                    <thead>
                                        <tr style={{ textAlign: "left" }}>
                                            <th>{_("User")}</th>
                                            <th>{_("Host")}</th>
                                            <th>{_("Plugin")}</th>
                                            <th />
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {users.map((user) => (
                                            <tr
                                                key={`${user.name}@${user.host}`}
                                                style={{ borderTop: "1px solid #d2d2d2" }}
                                            >
                                                <td>{user.name}</td>
                                                <td>{user.host}</td>
                                                <td>{user.plugin || "–"}</td>
                                                <td>
                                                    <button
                                                        type="button"
                                                        onClick={() => dropUser(user)}
                                                        style={{
                                                            ...buttonStyle,
                                                            background: "var(--pf-global--palette--red-500, #c9190b)",
                                                            padding: "4px 8px",
                                                        }}
                                                    >
                                                        {_("Drop")}
                                                    </button>
                                                </td>
                                            </tr>
                                        ))}
                                        {users.length === 0 && (
                                            <tr>
                                                <td colSpan={4} style={{ textAlign: "center", padding: 12 }}>
                                                    {_("No users visible. Ensure this account can read mysql.user.")}
                                                </td>
                                            </tr>
                                        )}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    </section>

                    <section style={{ display: "grid", gridTemplateColumns: "1fr", gap: 16 }}>
                        <div style={{ ...panelStyle, padding: 12 }}>
                            <h2 style={{ marginTop: 0 }}>
                                {currentDatabase
                                    ? cockpit.format(_("Tables in $0"), currentDatabase.name)
                                    : _("Tables")}
                            </h2>
                            {tablesError && (
                                <div style={{ color: "var(--pf-global--palette--red-500, #c9190b)" }}>
                                    {tablesError}
                                </div>
                            )}
                            {tablesLoading ? (
                                <p>{_("Loading tables…")}</p>
                            ) : (
                                <div style={{ maxHeight: 280, overflowY: "auto" }}>
                                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
                                        <thead>
                                            <tr style={{ textAlign: "left" }}>
                                                <th>{_("Table")}</th>
                                                <th>{_("Rows")}</th>
                                                <th>{_("Engine")}</th>
                                                <th>{_("Size")}</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {tables.map((table) => (
                                                <tr key={table.name} style={{ borderTop: "1px solid #d2d2d2" }}>
                                                    <td>
                                                        {table.name}
                                                        {table.collation && (
                                                            <div style={{ fontSize: 12, color: "#6a6e73" }}>
                                                                {table.collation}
                                                            </div>
                                                        )}
                                                    </td>
                                                    <td>{table.rows ?? "–"}</td>
                                                    <td>{table.engine || ""}</td>
                                                    <td>{formatBytes(table.sizeBytes)}</td>
                                                </tr>
                                            ))}
                                            {tables.length === 0 && (
                                                <tr>
                                                    <td colSpan={4} style={{ textAlign: "center", padding: 12 }}>
                                                        {connection.database
                                                            ? _("No tables returned for this database.")
                                                            : _("Select a database to view its tables.")}
                                                    </td>
                                                </tr>
                                            )}
                                        </tbody>
                                    </table>
                                </div>
                            )}
                        </div>

                        <div style={{ ...panelStyle, padding: 12 }}>
                            <h2 style={{ marginTop: 0 }}>{_("SQL Console")}</h2>
                            <form onSubmit={handleRunQuery} style={{ display: "grid", gap: 8 }}>
                                <textarea
                                    style={{
                                        ...inputStyle,
                                        minHeight: 140,
                                        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                                    }}
                                    value={queryText}
                                    onChange={(event) => setQueryText(event.target.value)}
                                />
                                <div style={{ display: "flex", gap: 8 }}>
                                    <select
                                        style={{ ...inputStyle, flex: 1 }}
                                        value={connection.database}
                                        onChange={(event) =>
                                            setConnection((prev) => ({ ...prev, database: event.target.value }))
                                        }
                                    >
                                        <option value="">{_("No database selected")}</option>
                                        {databases.map((db) => (
                                            <option key={db.name} value={db.name}>
                                                {db.name}
                                            </option>
                                        ))}
                                    </select>
                                    <button
                                        type="submit"
                                        style={{ ...buttonStyle, minWidth: 150 }}
                                        disabled={queryBusy}
                                    >
                                        {queryBusy ? _("Running…") : _("Run query")}
                                    </button>
                                </div>
                            </form>
                            {queryResult && (
                                <div style={{ marginTop: 12 }}>
                                    {queryResult.message && (
                                        <div style={{ marginBottom: 8 }}>{queryResult.message}</div>
                                    )}
                                    {queryResult.columns.length > 0 && (
                                        <div style={{ maxHeight: 260, overflow: "auto" }}>
                                            <table
                                                style={{ borderCollapse: "collapse", width: "100%", fontSize: 14 }}
                                            >
                                                <thead>
                                                    <tr>
                                                        {queryResult.columns.map((column) => (
                                                            <th
                                                                key={column}
                                                                style={{
                                                                    textAlign: "left",
                                                                    borderBottom: "1px solid #d2d2d2",
                                                                    paddingBottom: 4,
                                                                }}
                                                            >
                                                                {column}
                                                            </th>
                                                        ))}
                                                    </tr>
                                                </thead>
                                                <tbody>
                                                    {queryResult.rows.map((row, index) => (
                                                        <tr key={index}>
                                                            {row.map((value, valueIndex) => (
                                                                <td
                                                                    key={`${index}-${valueIndex}`}
                                                                    style={{
                                                                        borderTop: "1px solid #ededed",
                                                                        padding: "6px 4px",
                                                                    }}
                                                                >
                                                                    {value === null || value === undefined
                                                                        ? "NULL"
                                                                        : String(value)}
                                                                </td>
                                                            ))}
                                                        </tr>
                                                    ))}
                                                </tbody>
                                            </table>
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    </section>
                </div>
                {/* </div> */}
            </CardBody>
        </Card>
    );
};

export { Application };
