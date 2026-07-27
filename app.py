from __future__ import annotations

import csv
import io
import os
import re
import secrets
import sqlite3
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from flask import Flask, abort, jsonify, request, send_from_directory, session
from werkzeug.security import check_password_hash, generate_password_hash

ROOT = Path(__file__).resolve().parent
DB_PATH = ROOT / "data" / "consumables.db"
APP_ENV = os.environ.get("APP_ENV", os.environ.get("FLASK_ENV", "development")).strip().lower()


def env_bool(name: str, default: bool) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


LAB_HEAD_EMAIL = os.environ.get("PANCREASYS_LAB_HEAD_EMAIL", "umahajan@niper.ac.in")
LAB_HEAD_DEFAULT_PASSWORD = os.environ.get("PANCREASYS_LAB_HEAD_PASSWORD", "labhead12345")
DEMO_EMAIL = "demo@pancreasys.lab"
DEMO_PASSWORD = os.environ.get("PANCREASYS_DEMO_PASSWORD")
ENABLE_DEMO_SIGNIN = env_bool("PANCREASYS_ENABLE_DEMO_SIGNIN", APP_ENV != "production")
STATIC_DIRS = {"css", "js", "images", "sections", "data", "consumables"}
EXTRA_STATIC_FILES = {"manifest.webmanifest", "sw.js"}
DEFAULT_SECRET_KEY = "pancreasys-dev-secret-change-me"
SIGNIN_MAX_ATTEMPTS = int(os.environ.get("PANCREASYS_SIGNIN_MAX_ATTEMPTS", "6"))
SIGNIN_WINDOW_SECONDS = int(os.environ.get("PANCREASYS_SIGNIN_WINDOW_SECONDS", "300"))
RESET_TOKEN_TTL_SECONDS = int(os.environ.get("PANCREASYS_RESET_TOKEN_TTL_SECONDS", "3600"))

app = Flask(__name__, static_folder=None)
app.secret_key = os.environ.get("FLASK_SECRET_KEY", DEFAULT_SECRET_KEY)
app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=env_bool("FLASK_SESSION_COOKIE_SECURE", APP_ENV == "production"),
)

_SIGNIN_ATTEMPTS: dict[str, list[datetime]] = {}


def enforce_security_config() -> None:
    if APP_ENV != "production":
        return

    if app.secret_key == DEFAULT_SECRET_KEY:
        raise RuntimeError("FLASK_SECRET_KEY must be set in production.")

    if LAB_HEAD_DEFAULT_PASSWORD == "labhead12345":
        raise RuntimeError("PANCREASYS_LAB_HEAD_PASSWORD must be changed in production.")

    if ENABLE_DEMO_SIGNIN and not DEMO_PASSWORD:
        raise RuntimeError("PANCREASYS_DEMO_PASSWORD must be set when demo sign-in is enabled in production.")


def client_identifier() -> str:
    forwarded_for = request.headers.get("X-Forwarded-For", "")
    if forwarded_for:
        return forwarded_for.split(",")[0].strip()
    return request.remote_addr or "unknown"


def is_signin_rate_limited(identifier: str) -> bool:
    now = datetime.now(UTC)
    cutoff = now.timestamp() - SIGNIN_WINDOW_SECONDS
    history = _SIGNIN_ATTEMPTS.get(identifier, [])
    history = [attempt for attempt in history if attempt.timestamp() >= cutoff]
    _SIGNIN_ATTEMPTS[identifier] = history
    return len(history) >= SIGNIN_MAX_ATTEMPTS


def register_signin_failure(identifier: str) -> None:
    history = _SIGNIN_ATTEMPTS.setdefault(identifier, [])
    history.append(datetime.now(UTC))


def clear_signin_failures(identifier: str) -> None:
    _SIGNIN_ATTEMPTS.pop(identifier, None)


enforce_security_config()

REQUEST_COLUMNS = {
    "requester_role": "TEXT",
    "availability_label": "TEXT",
    "status_label": "TEXT",
    "received_at": "TEXT",
    "matched_item_key": "TEXT",
    "matched_last_ordered_at": "TEXT",
    "matched_stored_at": "TEXT",
    "matched_status": "TEXT",
}

USER_COLUMNS = {
    "reset_password_token": "TEXT",
    "reset_password_sent_at": "TEXT",
}


def now_iso() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def parse_iso(value: str | None) -> datetime | None:
    if not value:
        return None

    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def open_db() -> sqlite3.Connection:
    connection = sqlite3.connect(DB_PATH)
    connection.row_factory = sqlite3.Row
    ensure_schema(connection)
    ensure_seed_users(connection)
    return connection


def ensure_schema(connection: sqlite3.Connection) -> None:
    connection.executescript(
        """
        CREATE TABLE IF NOT EXISTS purchase_requests (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            requester_name TEXT NOT NULL,
            requester_email TEXT,
            requester_role TEXT,
            item_name TEXT NOT NULL,
            catalogue_number TEXT,
            manufacturer TEXT,
            requested_quantity TEXT,
            availability_status TEXT NOT NULL,
            availability_label TEXT,
            request_notes TEXT,
            status TEXT NOT NULL DEFAULT 'pending_lab_head',
            status_label TEXT,
            created_at TEXT NOT NULL,
            confirmed_at TEXT,
            ordered_at TEXT,
            received_at TEXT,
            stored_at TEXT,
            matched_item_key TEXT,
            matched_last_ordered_at TEXT,
            matched_stored_at TEXT,
            matched_status TEXT,
            lab_head_email TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS lab_users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            email TEXT NOT NULL UNIQUE,
            role TEXT NOT NULL,
            password_hash TEXT NOT NULL,
            approved INTEGER NOT NULL DEFAULT 0,
            approval_token TEXT,
            reset_password_token TEXT,
            reset_password_sent_at TEXT,
            created_at TEXT NOT NULL
        );
        """
    )

    existing_columns = {
        row["name"] for row in connection.execute("PRAGMA table_info(purchase_requests)").fetchall()
    }
    for column, definition in REQUEST_COLUMNS.items():
        if column not in existing_columns:
            connection.execute(f"ALTER TABLE purchase_requests ADD COLUMN {column} {definition}")

    existing_user_columns = {
        row["name"] for row in connection.execute("PRAGMA table_info(lab_users)").fetchall()
    }
    for column, definition in USER_COLUMNS.items():
        if column not in existing_user_columns:
            connection.execute(f"ALTER TABLE lab_users ADD COLUMN {column} {definition}")

    connection.commit()


def ensure_seed_users(connection: sqlite3.Connection) -> None:
    seed_users = [
        {
            "name": "Dr. Ujjwal Mahajan",
            "email": LAB_HEAD_EMAIL,
            "role": "Lab Head",
            "password_hash": generate_password_hash(LAB_HEAD_DEFAULT_PASSWORD),
            "approved": 1,
        },
    ]

    if DEMO_PASSWORD:
        seed_users.append(
            {
                "name": "Demo User",
                "email": DEMO_EMAIL,
                "role": "Guest",
                "password_hash": generate_password_hash(DEMO_PASSWORD),
                "approved": 1,
            }
        )

    for user in seed_users:
        existing = connection.execute(
            "SELECT id FROM lab_users WHERE email = ?",
            (user["email"],),
        ).fetchone()
        if existing is None:
            connection.execute(
                """
                INSERT INTO lab_users (name, email, role, password_hash, approved, approval_token, created_at)
                VALUES (?, ?, ?, ?, ?, NULL, ?)
                """,
                (
                    user["name"],
                    user["email"],
                    user["role"],
                    user["password_hash"],
                    user["approved"],
                    now_iso(),
                ),
            )

    connection.commit()


def is_lab_head(user: sqlite3.Row | dict[str, Any] | None) -> bool:
    if not user:
        return False
    email = user["email"] if isinstance(user, sqlite3.Row) else user.get("email")
    role = user["role"] if isinstance(user, sqlite3.Row) else user.get("role")
    return email == LAB_HEAD_EMAIL or "lab head" in str(role).lower()


def user_to_public(user: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": user["id"],
        "name": user["name"],
        "email": user["email"],
        "role": user["role"],
        "approved": bool(user["approved"]),
        "isLabHead": is_lab_head(user),
    }


def build_app_hash_link(token_name: str, token_value: str) -> str:
    return f"{request.host_url.rstrip('/')}/#{token_name}={token_value}"


def password_reset_link(user: sqlite3.Row | dict[str, Any]) -> str:
    token = user["reset_password_token"] if isinstance(user, sqlite3.Row) else user.get("reset_password_token")
    return build_app_hash_link("reset", token)


def is_reset_token_expired(user: sqlite3.Row) -> bool:
    sent_at = parse_iso(user["reset_password_sent_at"])
    if sent_at is None:
        return True
    return (datetime.now(UTC) - sent_at).total_seconds() > RESET_TOKEN_TTL_SECONDS


def current_user(connection: sqlite3.Connection) -> sqlite3.Row | None:
    user_id = session.get("user_id")
    if not user_id:
        return None
    return connection.execute("SELECT * FROM lab_users WHERE id = ?", (user_id,)).fetchone()


def row_to_item(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "item_key": row["item_key"],
        "category": row["category"],
        "name": row["name"],
        "manufacturer": row["manufacturer"],
        "catalogue_number": row["catalogue_number"],
        "quantity_text": row["quantity_text"],
        "quantity_value": row["quantity_value"],
        "ordered_date": row["ordered_date"],
        "date_of_issue": row["date_of_issue"],
        "stored_at": row["stored_at"],
        "status": row["status"],
        "approved_by": row["approved_by"],
        "ordered_by": row["ordered_by"],
        "received_by": row["received_by"],
        "project": row["project"],
        "search_text": row["search_text"],
    }


def row_to_request(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "requesterName": row["requester_name"],
        "requesterEmail": row["requester_email"],
        "requesterRole": row["requester_role"],
        "itemName": row["item_name"],
        "catalogueNumber": row["catalogue_number"],
        "manufacturer": row["manufacturer"],
        "quantity": row["requested_quantity"],
        "availability": row["availability_status"],
        "availabilityLabel": row["availability_label"] or row["availability_status"],
        "notes": row["request_notes"],
        "status": row["status"],
        "statusLabel": row["status_label"] or row["status"],
        "createdAt": row["created_at"],
        "confirmedAt": row["confirmed_at"],
        "orderedAt": row["ordered_at"],
        "receivedAt": row["received_at"],
        "storedAt": row["stored_at"],
        "labHeadEmail": row["lab_head_email"],
        "matchedItemKey": row["matched_item_key"],
        "matchedItemSnapshot": {
            "lastOrderedAt": row["matched_last_ordered_at"],
            "storedAt": row["matched_stored_at"],
            "status": row["matched_status"],
        },
    }


def make_item_key(name: str, catalogue_number: str | None, manufacturer: str | None, category: str) -> str:
    parts = [name, catalogue_number or "", manufacturer or "", category]
    normalized = [re.sub(r"[^a-z0-9]+", "-", part.lower()).strip("-") for part in parts]
    return "::".join(part or "na" for part in normalized)


def search_text(name: str, catalogue_number: str | None, manufacturer: str | None, category: str) -> str:
    return " ".join(part for part in [name, catalogue_number, manufacturer, category] if part).lower()


def json_error(message: str, status: int = 400):
    response = jsonify({"error": message})
    response.status_code = status
    return response


def csv_escape(value: Any) -> str:
    if value is None:
        return ""
    return str(value)


def update_catalog_for_request(connection: sqlite3.Connection, request_row: sqlite3.Row) -> None:
    existing = None
    item_key = request_row["matched_item_key"]
    if item_key:
        existing = connection.execute(
            "SELECT * FROM catalog WHERE item_key = ?",
            (item_key,),
        ).fetchone()

    category = existing["category"] if existing else "Custom requests"
    item_key = item_key or make_item_key(
        request_row["item_name"],
        request_row["catalogue_number"],
        request_row["manufacturer"],
        category,
    )
    quantity_text = request_row["requested_quantity"]
    quantity_value = None
    if quantity_text:
        match = re.search(r"-?\d+(?:\.\d+)?", quantity_text)
        quantity_value = float(match.group()) if match else None

    payload = {
        "item_key": item_key,
        "category": category,
        "name": request_row["item_name"],
        "manufacturer": request_row["manufacturer"] or (existing["manufacturer"] if existing else None),
        "catalogue_number": request_row["catalogue_number"] or (existing["catalogue_number"] if existing else None),
        "quantity_text": quantity_text,
        "quantity_value": quantity_value,
        "ordered_date": request_row["ordered_at"] or request_row["created_at"],
        "date_of_issue": request_row["received_at"] or request_row["created_at"],
        "stored_at": request_row["stored_at"],
        "status": "Available in storage",
        "approved_by": "Lab Head",
        "ordered_by": "Lab Head",
        "received_by": request_row["requester_name"],
        "project": existing["project"] if existing else None,
        "search_text": search_text(
            request_row["item_name"],
            request_row["catalogue_number"],
            request_row["manufacturer"],
            category,
        ),
    }

    connection.execute(
        """
        INSERT INTO catalog (
            item_key, category, name, manufacturer, catalogue_number, quantity_text, quantity_value,
            ordered_date, date_of_issue, stored_at, status, approved_by, ordered_by, received_by,
            project, search_text
        ) VALUES (
            :item_key, :category, :name, :manufacturer, :catalogue_number, :quantity_text, :quantity_value,
            :ordered_date, :date_of_issue, :stored_at, :status, :approved_by, :ordered_by, :received_by,
            :project, :search_text
        )
        ON CONFLICT(item_key) DO UPDATE SET
            name = excluded.name,
            manufacturer = excluded.manufacturer,
            catalogue_number = excluded.catalogue_number,
            quantity_text = excluded.quantity_text,
            quantity_value = excluded.quantity_value,
            ordered_date = excluded.ordered_date,
            date_of_issue = excluded.date_of_issue,
            stored_at = excluded.stored_at,
            status = excluded.status,
            approved_by = excluded.approved_by,
            ordered_by = excluded.ordered_by,
            received_by = excluded.received_by,
            project = COALESCE(excluded.project, catalog.project),
            search_text = excluded.search_text
        """,
        payload,
    )

    connection.execute(
        """
        INSERT INTO order_history (
            item_key, category, name, manufacturer, catalogue_number, quantity_text, quantity_value,
            ordered_date, date_of_issue, stored_at, status, approved_by, ordered_by, received_by,
            project, mode_of_order, source_sheet, source_row, search_text
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            payload["item_key"],
            payload["category"],
            payload["name"],
            payload["manufacturer"],
            payload["catalogue_number"],
            payload["quantity_text"],
            payload["quantity_value"],
            payload["ordered_date"],
            payload["date_of_issue"],
            payload["stored_at"],
            payload["status"],
            payload["approved_by"],
            payload["ordered_by"],
            payload["received_by"],
            payload["project"],
            "Purchase request",
            "purchase_requests",
            request_row["id"],
            payload["search_text"],
        ),
    )


@app.get("/api/health")
def health_check():
    return jsonify({"status": "ok"})


@app.get("/api/auth/session")
def auth_session():
    with open_db() as connection:
        user = current_user(connection)
        if user is None:
            return jsonify({"authenticated": False, "user": None, "labHeadEmail": LAB_HEAD_EMAIL})
        return jsonify({"authenticated": True, "user": user_to_public(user), "labHeadEmail": LAB_HEAD_EMAIL})


@app.post("/api/auth/signup")
def auth_signup():
    payload = request.get_json(silent=True) or {}
    name = (payload.get("name") or "").strip()
    email = (payload.get("email") or "").strip().lower()
    role = (payload.get("role") or "").strip()
    password = payload.get("password") or ""
    confirm_password = payload.get("confirmPassword") or ""

    if not name or not email or not role:
        return json_error("Name, email, and role are required.")
    if password != confirm_password:
        return json_error("Passwords do not match.")
    if len(password) < 8:
        return json_error("Password must be at least 8 characters long.")

    approval_token = secrets.token_urlsafe(24)

    with open_db() as connection:
        existing = connection.execute("SELECT id FROM lab_users WHERE email = ?", (email,)).fetchone()
        if existing is not None:
            return json_error("An account with this email already exists.")

        connection.execute(
            """
            INSERT INTO lab_users (name, email, role, password_hash, approved, approval_token, created_at)
            VALUES (?, ?, ?, ?, 0, ?, ?)
            """,
            (name, email, role, generate_password_hash(password), approval_token, now_iso()),
        )
        connection.commit()

    approval_link = build_app_hash_link("approve", approval_token)
    return jsonify(
        {
            "message": "Account created. Approval from the lab head is required before sign-in.",
            "approvalLink": approval_link,
            "labHeadEmail": LAB_HEAD_EMAIL,
        }
    ), 201


@app.post("/api/auth/signin")
def auth_signin():
    payload = request.get_json(silent=True) or {}
    email = (payload.get("email") or "").strip().lower()
    password = payload.get("password") or ""
    identifier = client_identifier()

    if is_signin_rate_limited(identifier):
        return json_error("Too many sign-in attempts. Please try again in a few minutes.", status=429)

    with open_db() as connection:
        user = connection.execute("SELECT * FROM lab_users WHERE email = ?", (email,)).fetchone()
        if user is None or not check_password_hash(user["password_hash"], password):
            register_signin_failure(identifier)
            return json_error("Invalid email or password.", status=401)
        if not user["approved"]:
            return json_error(
                "Your account is pending approval from Dr. Ujjwal Mahajan. Please share the approval link with the PI.",
                status=403,
            )

        clear_signin_failures(identifier)
        session["user_id"] = user["id"]
        return jsonify({"message": "Signed in successfully.", "user": user_to_public(user)})


@app.post("/api/auth/demo-signin")
def auth_demo_signin():
    if not ENABLE_DEMO_SIGNIN:
        return json_error("Demo sign-in is disabled.", status=403)

    identifier = client_identifier()
    if is_signin_rate_limited(identifier):
        return json_error("Too many sign-in attempts. Please try again in a few minutes.", status=429)

    with open_db() as connection:
        user = connection.execute("SELECT * FROM lab_users WHERE email = ?", (DEMO_EMAIL,)).fetchone()
        if user is None:
            return json_error("Demo account is not configured.", status=404)
        if not user["approved"]:
            return json_error("Demo account is pending approval.", status=403)

        clear_signin_failures(identifier)
        session["user_id"] = user["id"]
        return jsonify({"message": "Signed in with demo account.", "user": user_to_public(user)})


@app.post("/api/auth/signout")
def auth_signout():
    session.clear()
    return jsonify({"message": "Signed out."})


@app.post("/api/auth/request-password-reset")
def auth_request_password_reset():
    payload = request.get_json(silent=True) or {}
    email = (payload.get("email") or "").strip().lower()

    if not email:
        return json_error("Email is required.")

    with open_db() as connection:
        user = connection.execute("SELECT * FROM lab_users WHERE email = ?", (email,)).fetchone()
        if user is None:
            return json_error("No account found for this email.", status=404)

        reset_token = secrets.token_urlsafe(24)
        reset_sent_at = now_iso()
        connection.execute(
            """
            UPDATE lab_users
            SET reset_password_token = ?, reset_password_sent_at = ?
            WHERE id = ?
            """,
            (reset_token, reset_sent_at, user["id"]),
        )
        connection.commit()
        refreshed = connection.execute("SELECT * FROM lab_users WHERE id = ?", (user["id"],)).fetchone()

    return jsonify(
        {
            "message": "Password reset link created.",
            "email": refreshed["email"],
            "resetLink": password_reset_link(refreshed),
            "expiresInSeconds": RESET_TOKEN_TTL_SECONDS,
        }
    )


@app.post("/api/auth/reset-password/<token>")
def auth_reset_password(token: str):
    payload = request.get_json(silent=True) or {}
    password = payload.get("password") or ""
    confirm_password = payload.get("confirmPassword") or ""

    if password != confirm_password:
        return json_error("Passwords do not match.")
    if len(password) < 8:
        return json_error("Password must be at least 8 characters long.")

    with open_db() as connection:
        user = connection.execute("SELECT * FROM lab_users WHERE reset_password_token = ?", (token,)).fetchone()
        if user is None:
            return json_error("Invalid password reset link.", status=404)
        if is_reset_token_expired(user):
            connection.execute(
                """
                UPDATE lab_users
                SET reset_password_token = NULL, reset_password_sent_at = NULL
                WHERE id = ?
                """,
                (user["id"],),
            )
            connection.commit()
            return json_error("This password reset link has expired. Request a new one.", status=410)

        connection.execute(
            """
            UPDATE lab_users
            SET password_hash = ?, reset_password_token = NULL, reset_password_sent_at = NULL
            WHERE id = ?
            """,
            (generate_password_hash(password), user["id"]),
        )
        connection.commit()

    session.clear()
    clear_signin_failures(client_identifier())
    return jsonify({"message": "Password updated successfully. You can sign in with the new password."})


@app.post("/api/auth/approve/<token>")
def auth_approve(token: str):
    with open_db() as connection:
        user = connection.execute("SELECT * FROM lab_users WHERE approval_token = ?", (token,)).fetchone()
        if user is None:
            return json_error("Invalid approval link.", status=404)

        connection.execute(
            "UPDATE lab_users SET approved = 1, approval_token = NULL WHERE id = ?",
            (user["id"],),
        )
        connection.commit()
        refreshed = connection.execute("SELECT * FROM lab_users WHERE id = ?", (user["id"],)).fetchone()
        return jsonify(
            {
                "message": f"Account for {refreshed['email']} approved successfully.",
                "user": user_to_public(refreshed),
            }
        )


@app.get("/api/consumables/bootstrap")
def consumables_bootstrap():
    with open_db() as connection:
        user = current_user(connection)
        items = [
            row_to_item(row)
            for row in connection.execute("SELECT * FROM catalog ORDER BY LOWER(name), LOWER(category)").fetchall()
        ]
        requests_payload = [
            row_to_request(row)
            for row in connection.execute("SELECT * FROM purchase_requests ORDER BY datetime(created_at) DESC, id DESC").fetchall()
        ]

    summary = {
        "catalogItems": len(items),
        "savedRequests": len(requests_payload),
        "pendingRequests": sum(1 for item in requests_payload if item["status"] == "pending_lab_head"),
    }
    return jsonify(
        {
            "generatedAt": now_iso(),
            "labHeadEmail": LAB_HEAD_EMAIL,
            "currentUser": user_to_public(user) if user is not None else None,
            "summary": summary,
            "items": items,
            "requests": requests_payload,
        }
    )


@app.post("/api/consumables/requests")
def create_request():
    payload = request.get_json(silent=True) or {}
    item_name = (payload.get("itemName") or "").strip()
    availability = payload.get("availability") or "available"

    if not item_name:
        return json_error("Item name is required.")

    with open_db() as connection:
        user = current_user(connection)
        if user is None:
            return json_error("Sign in is required before creating a consumables request.", status=401)

        created_at = now_iso()
        status = "pending_lab_head" if availability == "not-available" else "requested_from_stock"
        status_label = "Pending with lab head" if status == "pending_lab_head" else "Check existing stock"
        availability_label = (
            "Not available in lab storage" if availability == "not-available" else "Available / needs stock check"
        )

        values = (
            user["name"],
            user["email"],
            user["role"],
            item_name,
            (payload.get("catalogueNumber") or "").strip() or None,
            (payload.get("manufacturer") or "").strip() or None,
            (payload.get("quantity") or "").strip() or None,
            availability,
            availability_label,
            (payload.get("notes") or "").strip() or None,
            status,
            status_label,
            created_at,
            created_at if status == "pending_lab_head" else None,
            None,
            None,
            None,
            payload.get("matchedItemKey"),
            (payload.get("matchedItemSnapshot") or {}).get("lastOrderedAt"),
            (payload.get("matchedItemSnapshot") or {}).get("storedAt"),
            (payload.get("matchedItemSnapshot") or {}).get("status"),
            LAB_HEAD_EMAIL,
        )

        cursor = connection.execute(
            """
            INSERT INTO purchase_requests (
                requester_name, requester_email, requester_role, item_name, catalogue_number, manufacturer,
                requested_quantity, availability_status, availability_label, request_notes, status, status_label,
                created_at, confirmed_at, ordered_at, received_at, stored_at, matched_item_key,
                matched_last_ordered_at, matched_stored_at, matched_status, lab_head_email
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            values,
        )
        connection.commit()
        row = connection.execute(
            "SELECT * FROM purchase_requests WHERE id = ?",
            (cursor.lastrowid,),
        ).fetchone()

    return jsonify(row_to_request(row)), 201


@app.patch("/api/consumables/requests/<int:request_id>")
def update_request(request_id: int):
    payload = request.get_json(silent=True) or {}
    action = payload.get("action")
    if action not in {"ordered", "stored"}:
        return json_error("Unsupported request action.")

    with open_db() as connection:
        user = current_user(connection)
        if user is None:
            return json_error("Sign in is required before updating a request.", status=401)
        if not is_lab_head(user):
            return json_error("Only the lab head can update request status.", status=403)

        row = connection.execute(
            "SELECT * FROM purchase_requests WHERE id = ?",
            (request_id,),
        ).fetchone()
        if row is None:
            return json_error("Request not found.", status=404)

        if action == "ordered":
            connection.execute(
                """
                UPDATE purchase_requests
                SET status = ?, status_label = ?, ordered_at = ?
                WHERE id = ?
                """,
                ("ordered_by_lab_head", "Ordered by lab head", now_iso(), request_id),
            )
        else:
            stored_at = (payload.get("storedAt") or "").strip() or "Not recorded"
            received_at = now_iso()
            connection.execute(
                """
                UPDATE purchase_requests
                SET status = ?, status_label = ?, stored_at = ?, received_at = ?
                WHERE id = ?
                """,
                ("stored", "Stored in lab", stored_at, received_at, request_id),
            )
            refreshed = connection.execute(
                "SELECT * FROM purchase_requests WHERE id = ?",
                (request_id,),
            ).fetchone()
            update_catalog_for_request(connection, refreshed)

        connection.commit()
        updated_row = connection.execute(
            "SELECT * FROM purchase_requests WHERE id = ?",
            (request_id,),
        ).fetchone()

    return jsonify(row_to_request(updated_row))


@app.get("/api/consumables/ordered.csv")
def download_ordered_requests_csv():
    with open_db() as connection:
        user = current_user(connection)
        if user is None:
            return json_error("Sign in is required before downloading ordered requests.", status=401)

        ordered_rows = connection.execute(
            """
            SELECT *
            FROM purchase_requests
            WHERE status IN ('ordered_by_lab_head', 'stored')
            ORDER BY datetime(COALESCE(ordered_at, created_at)) DESC, id DESC
            """
        ).fetchall()

    generated_at = now_iso()
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(
        [
            "export_generated_at_utc",
            "request_id",
            "item_name",
            "catalogue_number",
            "manufacturer",
            "requested_quantity",
            "requester_name",
            "requester_email",
            "status",
            "status_label",
            "created_at",
            "ordered_at",
            "received_at",
            "stored_at",
            "request_notes",
        ]
    )

    for row in ordered_rows:
        writer.writerow(
            [
                generated_at,
                csv_escape(row["id"]),
                csv_escape(row["item_name"]),
                csv_escape(row["catalogue_number"]),
                csv_escape(row["manufacturer"]),
                csv_escape(row["requested_quantity"]),
                csv_escape(row["requester_name"]),
                csv_escape(row["requester_email"]),
                csv_escape(row["status"]),
                csv_escape(row["status_label"]),
                csv_escape(row["created_at"]),
                csv_escape(row["ordered_at"]),
                csv_escape(row["received_at"]),
                csv_escape(row["stored_at"]),
                csv_escape(row["request_notes"]),
            ]
        )

    timestamp = datetime.now(UTC).strftime("%Y%m%d-%H%M%S")
    response = app.response_class(output.getvalue(), mimetype="text/csv")
    response.headers["Content-Disposition"] = f"attachment; filename=ordered-consumables-{timestamp}.csv"
    return response


@app.get("/")
def serve_index():
    return send_from_directory(ROOT, "index.html")


@app.get("/<path:requested_path>")
def serve_site_file(requested_path: str):
    first_part = requested_path.split("/", 1)[0]
    if first_part not in STATIC_DIRS and requested_path not in EXTRA_STATIC_FILES and requested_path != "index.html":
        abort(404)
    return send_from_directory(ROOT, requested_path)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "5000")), debug=APP_ENV != "production")
