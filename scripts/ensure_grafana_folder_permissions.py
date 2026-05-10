import argparse
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")

parser = argparse.ArgumentParser(
    description="Ensure all users in each Grafana organization have Viewer access to the org and all its folders."
)
parser.add_argument("--grafana_user", required=True)
parser.add_argument("--grafana_password", required=True)
parser.add_argument("--grafana_url", required=True)
parser.add_argument("--dry-run", action="store_true", help="Log changes without applying them")

args = parser.parse_args()

grafana_url = args.grafana_url.rstrip("/")
grafana = requests.Session()
grafana.auth = (args.grafana_user, args.grafana_password)
grafana.headers.update({"Content-Type": "application/json"})


def get_all_orgs() -> list[dict]:
    res = grafana.get(f"{grafana_url}/orgs")
    res.raise_for_status()
    return res.json()


def switch_org(org_id: int):
    res = grafana.post(f"{grafana_url}/user/using/{org_id}")
    res.raise_for_status()


def get_org_users(org_id: int) -> list[dict]:
    res = grafana.get(f"{grafana_url}/orgs/{org_id}/users")
    res.raise_for_status()
    return res.json()


def ensure_user_is_viewer(org_id: int, user: dict):
    """Ensure user has at least Viewer role in the org."""
    if user.get("role") in ("Viewer", "Editor", "Admin"):
        return
    user_id = user["userId"]
    logging.info(f"  Updating user {user.get('email')} (id={user_id}) to Viewer in org {org_id}")
    if not args.dry_run:
        res = grafana.patch(
            f"{grafana_url}/orgs/{org_id}/users/{user_id}",
            json={"role": "Viewer"},
        )
        if res.status_code not in (200, 409):
            logging.error(f"  Failed to update user role: {res.status_code} {res.text}")


def get_folders() -> list[dict]:
    res = grafana.get(f"{grafana_url}/folders")
    res.raise_for_status()
    return res.json()


def get_folder_permissions(folder_uid: str) -> list[dict]:
    res = grafana.get(f"{grafana_url}/folders/{folder_uid}/permissions")
    res.raise_for_status()
    return res.json()


def update_folder_permissions(folder_uid: str, items: list[dict]):
    res = grafana.post(
        f"{grafana_url}/folders/{folder_uid}/permissions",
        json={"items": items},
    )
    if res.status_code not in (200,):
        logging.error(f"  Failed to update folder permissions: {res.status_code} {res.text}")
    return res


def ensure_folder_permissions(folder_uid: str, folder_title: str, org_users: list[dict]):
    """Ensure all org users have Viewer (permission=1) access to the folder."""
    existing_perms = get_folder_permissions(folder_uid)

    # Build the full permission list preserving existing entries
    items = []
    user_ids_with_perms: set[int] = set()

    for perm in existing_perms:
        entry: dict = {}
        if perm.get("userId") and perm["userId"] != 0:
            entry["userId"] = perm["userId"]
            user_ids_with_perms.add(perm["userId"])
        elif perm.get("teamId") and perm["teamId"] != 0:
            entry["teamId"] = perm["teamId"]
        elif perm.get("role"):
            entry["role"] = perm["role"]
        else:
            continue
        entry["permission"] = perm.get("permission", 1)
        items.append(entry)

    # Add missing users with Viewer permission (skip the SA admin user)
    added = 0
    for user in org_users:
        user_id = user.get("userId")
        if user.get("login") == "sa" or user.get("role") == "Admin":
            continue
        if user_id and user_id not in user_ids_with_perms:
            items.append({"userId": user_id, "permission": 1})
            added += 1

    if added == 0:
        logging.debug(f"    Folder '{folder_title}' ({folder_uid}): all users already have permissions")
        return

    logging.info(f"    Folder '{folder_title}' ({folder_uid}): adding viewer permission for {added} user(s)")
    if not args.dry_run:
        update_folder_permissions(folder_uid, items)


def main():
    orgs = get_all_orgs()
    logging.info(f"Found {len(orgs)} organization(s)")

    for org in orgs:
        org_id = org["id"]
        org_name = org.get("name", "unknown")

        # Skip the default org (id=1)
        if org_id == 1:
            logging.debug(f"Skipping default org (id=1)")
            continue

        logging.info(f"Processing org '{org_name}' (id={org_id})")

        # Switch admin context to this org
        try:
            switch_org(org_id)
        except requests.HTTPError as e:
            logging.error(f"  Failed to switch to org {org_id}: {e}")
            continue

        # Get all users in the org
        try:
            org_users = get_org_users(org_id)
        except requests.HTTPError as e:
            logging.error(f"  Failed to get users for org {org_id}: {e}")
            continue

        if not org_users:
            logging.info(f"  No users in org '{org_name}', skipping")
            continue

        logging.info(f"  Found {len(org_users)} user(s)")

        # Ensure all users have Viewer role in the org
        for user in org_users:
            ensure_user_is_viewer(org_id, user)

        # Get all folders in the org and ensure permissions
        try:
            folders = get_folders()
        except requests.HTTPError as e:
            logging.error(f"  Failed to get folders for org {org_id}: {e}")
            continue

        if not folders:
            logging.info(f"  No folders in org '{org_name}'")
            continue

        logging.info(f"  Found {len(folders)} folder(s)")
        for folder in folders:
            folder_uid = folder.get("uid")
            if not folder_uid:
                continue
            ensure_folder_permissions(folder_uid, folder.get("title", ""), org_users)

    logging.info("Done")


if __name__ == "__main__":
    main()
