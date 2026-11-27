mod oauth;

use std::{
    collections::HashMap,
    ffi::CString,
    fs::{self, File, Metadata, OpenOptions},
    io::{self, Cursor, Read, Seek, Write},
    os::unix::{
        ffi::OsStrExt,
        fs::{MetadataExt, OpenOptionsExt},
    },
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use base64::{Engine, engine::general_purpose::STANDARD};
use image::{ImageFormat, ImageReader, imageops::FilterType};
use keepass::{
    Database, DatabaseKey,
    config::DatabaseVersion,
    db::{EntryId, EntryMut, EntryRef, GroupId, GroupRef, History, Icon, Times, Value, fields},
    error::{
        DatabaseFormatError, DatabaseOpenError, Kdbx3OpenError, Kdbx3OuterHeaderError,
        Kdbx4OpenError, Kdbx4OuterHeaderError, ParseXmlError,
    },
};
use regex::RegexBuilder;
use serde::{Deserialize, Serialize};
use zeroize::{Zeroize, Zeroizing};

const DATABASE_LIMIT: u64 = 128 * 1024 * 1024;
const KEYFILE_LIMIT: u64 = 1024 * 1024;
const ENTRY_LIMIT: usize = 5_000;
const ATTACHMENT_LIMIT: u64 = 32 * 1024 * 1024;
const PREVIEW_LIMIT: usize = 2 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    database: String,
    master: String,
    keyfile: Option<String>,
    operation: Operation,
}

impl Drop for Request {
    fn drop(&mut self) {
        self.master.zeroize();
    }
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum Operation {
    List,
    Create {
        name: String,
    },
    SaveCopy {
        stamp: String,
        name: String,
        #[serde(default)]
        replace: bool,
        entry: Option<String>,
        fields: Changes,
    },
    ManageCopy {
        stamp: String,
        name: String,
        #[serde(default)]
        replace: bool,
        change: Management,
    },
    Rekey {
        stamp: String,
        name: String,
        new_master: Zeroizing<String>,
        new_keyfile: Option<String>,
    },
    Merge {
        stamp: String,
        name: String,
        remote: String,
    },
    Inspect {
        stamp: String,
        entry: String,
        history: Option<usize>,
    },
    Preview {
        stamp: String,
        entry: String,
        attachment: String,
        history: Option<usize>,
    },
    Export {
        stamp: String,
        entry: String,
        attachment: String,
        history: Option<usize>,
        directory: String,
        name: String,
    },
    Search {
        stamp: String,
        pattern: Zeroizing<String>,
        regex: bool,
        include_protected: bool,
        history: bool,
        trash: bool,
    },
    ReadCustom {
        stamp: String,
        entry: String,
        field: String,
    },
    Read {
        stamp: String,
        entry: String,
        field: Field,
    },
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum Management {
    AddGroup {
        parent: String,
        title: String,
    },
    RenameGroup {
        group: String,
        title: String,
    },
    MoveGroup {
        group: String,
        parent: String,
    },
    TrashGroup {
        group: String,
    },
    RestoreGroup {
        group: String,
    },
    PurgeGroup {
        group: String,
    },
    TrashEntry {
        entry: String,
    },
    RestoreEntry {
        entry: String,
    },
    PurgeEntry {
        entry: String,
    },
    AddAttachment {
        entry: String,
        path: String,
    },
    RemoveAttachment {
        entry: String,
        attachment: String,
    },
    RestoreHistory {
        entry: String,
        index: usize,
    },
    DeleteHistory {
        entry: String,
        index: usize,
    },
    SetCustom {
        entry: String,
        field: String,
        value: Zeroizing<String>,
        protected: bool,
        existing: bool,
    },
    RemoveCustom {
        entry: String,
        field: String,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum Field {
    Username,
    Password,
    Url,
    Notes,
    Totp,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Changes {
    title: Option<String>,
    username: Option<String>,
    url: Option<String>,
    notes: Option<String>,
    group: Option<String>,
    tags: Option<Vec<String>>,
    color: Option<String>,
    icon: Option<String>,
    icon_file: Option<String>,
    otp: Option<Zeroizing<String>>,
    password: Option<Zeroizing<String>>,
}

#[derive(Serialize)]
struct Entry {
    id: String,
    title: String,
    username: String,
    url: String,
    group: String,
    group_id: String,
    icon: Option<String>,
    color: Option<String>,
    tags: Vec<String>,
    trashed: bool,
    has_secret: bool,
    has_notes: bool,
    has_totp: bool,
    has_history: bool,
    has_attachments: bool,
}

#[derive(Serialize)]
struct Group {
    id: String,
    root: bool,
    trashed: bool,
    recycle_bin: bool,
    name: String,
    path: String,
}

#[derive(Serialize)]
struct Version {
    index: usize,
    has_attachments: bool,
    title: String,
    username: String,
    modified: Option<String>,
}

#[derive(Serialize)]
struct AttachmentInfo {
    name: String,
    size: usize,
}

#[derive(Serialize)]
struct CustomField {
    name: String,
    protected: bool,
    value: Option<String>,
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum Response<'a> {
    List {
        stamp: String,
        entries: Vec<Entry>,
        groups: Vec<Group>,
        icons: HashMap<String, String>,
        writable: bool,
        database: Option<String>,
        backup: Option<String>,
    },
    Details {
        versions: Vec<Version>,
        attachments: Vec<AttachmentInfo>,
        custom: Vec<CustomField>,
    },
    Exported,
    Matches {
        ids: Vec<String>,
    },
    Preview {
        mime: &'static str,
        data: &'a str,
    },
    Value {
        value: &'a str,
    },
    Error {
        code: &'static str,
    },
}

fn regular_file(path: &str, limit: u64) -> io::Result<(File, Metadata)> {
    let metadata = fs::metadata(path)?;
    if !metadata.is_file() || metadata.len() > limit {
        return Err(io::Error::other("not a supported regular file"));
    }
    let file = File::open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.len() > limit {
        return Err(io::Error::other("not a supported regular file"));
    }
    Ok((file, metadata))
}

fn stamp(meta: &Metadata) -> String {
    format!(
        "{}:{}:{}:{}:{}:{}:{}",
        meta.dev(),
        meta.ino(),
        meta.len(),
        meta.mtime(),
        meta.mtime_nsec(),
        meta.ctime(),
        meta.ctime_nsec()
    )
}

fn display(value: Option<&str>, maximum: usize) -> String {
    value.unwrap_or_default().chars().take(maximum).collect()
}

struct PendingFile(Option<PathBuf>);

impl Drop for PendingFile {
    fn drop(&mut self) {
        if let Some(path) = &self.0 {
            let _ = fs::remove_file(path);
        }
    }
}

fn publish(
    database: &Database,
    key: DatabaseKey,
    directory: &Path,
    name: &str,
    before_commit: impl FnOnce() -> Result<(), &'static str>,
) -> Result<String, &'static str> {
    let name = name.trim();
    if name.len() > 180
        || name
            .chars()
            .any(|c| c.is_control() || matches!(c, '/' | ':'))
        || !name.to_ascii_lowercase().ends_with(".kdbx")
        || name.len() == 5
    {
        return Err("name");
    }
    let destination = directory.join(name);
    let temporary =
        destination.with_file_name(format!(".tinycast-kdbx-{}.tmp", std::process::id()));
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temporary)
        .map_err(|_| "save")?;
    let _pending = PendingFile(Some(temporary.clone()));
    database.save(&mut output, key).map_err(|_| "save")?;
    if output.metadata().map_err(|_| "save")?.len() > DATABASE_LIMIT {
        return Err("save");
    }
    output.sync_all().map_err(|_| "save")?;
    before_commit()?;
    fs::hard_link(&temporary, &destination).map_err(|error| {
        if error.kind() == io::ErrorKind::AlreadyExists {
            "exists"
        } else {
            "save"
        }
    })?;
    Ok(destination.to_string_lossy().into_owned())
}

fn swap_files(first: &Path, second: &Path) -> io::Result<()> {
    let first = CString::new(first.as_os_str().as_bytes())?;
    let second = CString::new(second.as_os_str().as_bytes())?;
    // Both paths refer to files in the same directory. macOS exchanges both names atomically.
    if unsafe { libc::renamex_np(first.as_ptr(), second.as_ptr(), libc::RENAME_SWAP) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn same_file_content(a: &Metadata, b: &Metadata) -> bool {
    a.dev() == b.dev()
        && a.ino() == b.ino()
        && a.len() == b.len()
        && a.mtime() == b.mtime()
        && a.mtime_nsec() == b.mtime_nsec()
}

fn replace_with_backup(
    database: &Database,
    key: DatabaseKey,
    source: &Path,
    expected: &str,
) -> Result<String, &'static str> {
    let before = fs::symlink_metadata(source).map_err(|_| "changed")?;
    if !before.file_type().is_file() || before.permissions().readonly() {
        return Err("replace_file");
    }
    if stamp(&before) != expected {
        return Err("changed");
    }
    let time = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "save")?
        .as_millis();
    let stem: String = source
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("vault")
        .chars()
        .take(30)
        .collect();
    let backup = source.with_file_name(format!("{stem}-backup-{time}-{}.kdbx", std::process::id()));
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&backup)
        .map_err(|_| "replace_file")?;
    let mut staged = PendingFile(Some(backup.clone()));
    database.save(&mut output, key).map_err(|_| "save")?;
    let replacement = output.metadata().map_err(|_| "save")?;
    if replacement.len() > DATABASE_LIMIT {
        return Err("save");
    }
    output
        .set_permissions(before.permissions())
        .map_err(|_| "replace_file")?;
    output.sync_all().map_err(|_| "save")?;
    if stamp(&fs::symlink_metadata(source).map_err(|_| "changed")?) != expected {
        return Err("changed");
    }
    swap_files(&backup, source).map_err(|_| "replace_file")?;
    // From here the backup holds the displaced file. Never delete it on an error.
    staged.0 = None;
    if !fs::symlink_metadata(&backup).is_ok_and(|metadata| same_file_content(&metadata, &before)) {
        if fs::symlink_metadata(source)
            .is_ok_and(|metadata| same_file_content(&metadata, &replacement))
            && swap_files(&backup, source).is_ok()
        {
            // The old file is at the original path again. Staged is now the uncommitted replacement.
            staged.0 = Some(backup.clone());
            return Err("changed");
        }
        return Err("replace_conflict");
    }
    Ok(backup.to_string_lossy().into_owned())
}

fn group_path(database: &Database, first: GroupRef<'_>) -> Option<(String, bool)> {
    let trash = database.recycle_bin().map(|group| group.id());
    let mut group = Some(first);
    let mut names = Vec::new();
    let mut trashed = false;
    while let Some(ancestor) = group {
        if names.len() == 64 {
            return None;
        }
        trashed |= Some(ancestor.id()) == trash;
        names.push(display(Some(&ancestor.name), 72));
        group = ancestor
            .parent()
            .and_then(|parent| database.group(parent.id()));
    }
    names.reverse();
    Some((names.join(" / "), trashed))
}

fn entries(database: &Database) -> impl Iterator<Item = (EntryRef<'_>, String, bool)> {
    database.iter_all_entries().filter_map(|entry| {
        let (path, trashed) = group_path(database, entry.parent())?;
        Some((entry, path, trashed))
    })
}

fn group_id(database: &Database, id: &str) -> Result<GroupId, &'static str> {
    database
        .iter_all_groups()
        .find(|group| {
            group.id().uuid().to_string() == id
                && group_path(database, group.clone()).is_some_and(|(_, trashed)| !trashed)
        })
        .map(|group| group.id())
        .ok_or("group")
}

fn groups(database: &Database) -> Vec<Group> {
    let root = database.root().id();
    let bin = database.recycle_bin().map(|group| group.id());
    let mut listed: Vec<_> = database
        .iter_all_groups()
        .filter_map(|group| {
            let (path, trashed) = group_path(database, group.clone())?;
            Some(Group {
                id: group.id().uuid().to_string(),
                root: group.id() == root,
                trashed,
                recycle_bin: Some(group.id()) == bin,
                name: group.name.clone(),
                path,
            })
        })
        .collect();
    listed.sort_by(|a, b| (!a.root, &a.path).cmp(&(!b.root, &b.path)));
    listed
}

fn ensure_recycle_bin(database: &mut Database) -> GroupId {
    let root_id = database.root().id();
    let bin = database
        .recycle_bin()
        .map(|group| group.id())
        .filter(|id| *id != root_id)
        .unwrap_or_else(|| {
            let mut root = database.root_mut();
            let mut bin = root.add_group();
            bin.name = "Recycle Bin".into();
            bin.id()
        });
    if database.meta.recyclebin_enabled != Some(true)
        || database.meta.recyclebin_uuid != Some(bin.uuid())
    {
        database.meta.recyclebin_changed = Some(Times::now());
    }
    database.meta.recyclebin_enabled = Some(true);
    database.meta.recyclebin_uuid = Some(bin.uuid());
    bin
}

fn visible_entry<'a>(database: &'a Database, id: &str) -> Result<EntryRef<'a>, &'static str> {
    entries(database)
        .find(|(entry, _, trashed)| !trashed && entry.id().uuid().to_string() == id)
        .map(|(entry, _, _)| entry)
        .ok_or("entry")
}

fn with_entry_version(
    database: &Database,
    id: &str,
    history: Option<usize>,
    read: impl FnOnce(EntryRef<'_>) -> Result<(), &'static str>,
) -> Result<(), &'static str> {
    let entry = visible_entry(database, id)?;
    match history {
        Some(index) => read(entry.historical(index).ok_or("history")?),
        None => read(entry),
    }
}

fn preview_attachment(
    entry: EntryRef<'_>,
    name: &str,
    output: &mut impl Write,
) -> Result<(), &'static str> {
    let attachment = entry.attachment_by_name(name).ok_or("attachment")?;
    if attachment.data.len() > PREVIEW_LIMIT {
        return Err("preview_size");
    }
    let image = ImageReader::new(Cursor::new(attachment.data.as_slice()))
        .with_guessed_format()
        .map_err(|_| "preview_format")?;
    let mime = match image.format() {
        Some(ImageFormat::Png) => "image/png",
        Some(ImageFormat::Jpeg) => "image/jpeg",
        _ => return Err("preview_format"),
    };
    let (width, height) = image.into_dimensions().map_err(|_| "preview_format")?;
    if width == 0 || height == 0 || u64::from(width) * u64::from(height) > 24_000_000 {
        return Err("preview_size");
    }
    let data = Zeroizing::new(STANDARD.encode(attachment.data.as_slice()));
    serde_json::to_writer(output, &Response::Preview { mime, data: &data }).map_err(|_| "output")
}

fn import_icon(path: &str) -> Result<Vec<u8>, &'static str> {
    let limit = 1024 * 1024;
    let (file, _) = regular_file(path, limit).map_err(|_| "icon_file")?;
    let mut bytes = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "icon_file")?;
    if bytes.len() as u64 > limit {
        return Err("icon_file");
    }
    let reader = ImageReader::new(Cursor::new(bytes.as_slice()))
        .with_guessed_format()
        .map_err(|_| "icon_file")?;
    let format = reader
        .format()
        .filter(|value| matches!(value, ImageFormat::Png | ImageFormat::Jpeg))
        .ok_or("icon_file")?;
    let (width, height) = reader.into_dimensions().map_err(|_| "icon_file")?;
    if width == 0 || height == 0 || width > 1024 || height > 1024 {
        return Err("icon_file");
    }
    let mut png = Cursor::new(Vec::new());
    ImageReader::with_format(Cursor::new(bytes), format)
        .decode()
        .map_err(|_| "icon_file")?
        .resize(64, 64, FilterType::Triangle)
        .write_to(&mut png, ImageFormat::Png)
        .map_err(|_| "icon_file")?;
    Ok(png.into_inner())
}

fn stored_icon_image(bytes: &[u8]) -> Option<String> {
    if bytes.len() > 24 * 1024 || !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return None;
    }
    let (width, height) = ImageReader::with_format(Cursor::new(bytes), ImageFormat::Png)
        .into_dimensions()
        .ok()?;
    if width == 0 || height == 0 || width > 256 || height > 256 {
        return None;
    }
    Some(STANDARD.encode(bytes))
}

fn remove_current_attachments(
    database: &mut Database,
    id: EntryId,
    names: &[String],
) -> Result<(), &'static str> {
    if names.is_empty() {
        return Ok(());
    }
    let current = database.entry(id).ok_or("entry")?;
    let snapshot = (*current).clone();
    // The upstream removal API drops every attachment reference for the entry ID, including
    // historical references. Temporarily share the snapshot from a second entry and reindex
    // before and after detaching so both old versions and the new snapshot keep their blobs.
    let mut root = database.root_mut();
    let mut keeper = root.add_entry();
    let keeper_id = keeper.id();
    keeper.history.get_or_insert_default().add_entry(snapshot);
    database.remove_unused_attachments();
    {
        let mut entry = database.entry_mut(id).ok_or("entry")?;
        let mut tracked = entry.track_changes();
        for name in names {
            tracked.as_mut().remove_attachment_by_name(name);
        }
    }
    database.remove_unused_attachments();
    database.entry_mut(keeper_id).ok_or("entry")?.remove();
    database.remove_unused_attachments();
    Ok(())
}

fn export_attachment(
    entry: EntryRef<'_>,
    attachment: &str,
    directory: &str,
    name: &str,
) -> Result<(), &'static str> {
    let data = entry.attachment_by_name(attachment).ok_or("attachment")?;
    if name.is_empty()
        || matches!(name, "." | "..")
        || name.len() > 240
        || name
            .chars()
            .any(|character| character.is_control() || matches!(character, '/' | ':'))
    {
        return Err("attachment_name");
    }
    let destination = Path::new(directory).join(name);
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&destination)
        .map_err(|error| {
            if error.kind() == io::ErrorKind::AlreadyExists {
                "exists"
            } else {
                "attachment_export"
            }
        })?;
    if output
        .write_all(&data.data)
        .and_then(|()| output.sync_all())
        .is_err()
    {
        drop(output);
        let _ = fs::remove_file(destination);
        return Err("attachment_export");
    }
    Ok(())
}

fn custom_field(name: &str) -> bool {
    !name.trim().is_empty()
        && name.chars().count() <= 128
        && !name.chars().any(char::is_control)
        && ![
            fields::TITLE,
            fields::USERNAME,
            fields::PASSWORD,
            fields::URL,
            fields::NOTES,
            fields::OTP,
        ]
        .iter()
        .any(|standard| name.eq_ignore_ascii_case(standard))
}

fn manage(database: &mut Database, change: &Management) -> Result<(), &'static str> {
    match change {
        Management::SetCustom {
            entry,
            field,
            value,
            protected,
            existing,
        } => {
            let source = visible_entry(database, entry)?;
            let id = source.id();
            if !custom_field(field) || value.chars().count() > 2_000 {
                return Err("custom_field");
            }
            if source.fields.contains_key(field) != *existing {
                return Err(if *existing { "field" } else { "custom_exists" });
            }
            let value = if *protected {
                Value::protected(value.as_str())
            } else {
                Value::unprotected(value.as_str())
            };
            database
                .entry_mut(id)
                .ok_or("entry")?
                .track_changes()
                .set(field.as_str(), value);
        }
        Management::RemoveCustom { entry, field } => {
            let source = visible_entry(database, entry)?;
            let id = source.id();
            if !custom_field(field) || !source.fields.contains_key(field) {
                return Err("field");
            }
            database
                .entry_mut(id)
                .ok_or("entry")?
                .edit_tracking(|entry| {
                    entry.fields.remove(field);
                });
        }
        Management::AddAttachment { entry, path } => {
            let source = visible_entry(database, entry)?;
            let id = source.id();
            let name = Path::new(path)
                .file_name()
                .and_then(|name| name.to_str())
                .ok_or("attachment_name")?;
            if source.attachment_by_name(name).is_some() {
                return Err("attachment_exists");
            }
            let (file, _) =
                regular_file(path, ATTACHMENT_LIMIT).map_err(|_| "attachment_import")?;
            let mut data = Zeroizing::new(Vec::new());
            file.take(ATTACHMENT_LIMIT + 1)
                .read_to_end(&mut data)
                .map_err(|_| "attachment_import")?;
            if data.len() as u64 > ATTACHMENT_LIMIT {
                return Err("attachment_import");
            }
            database
                .entry_mut(id)
                .ok_or("entry")?
                .track_changes()
                .add_attachment(name, Value::protected(std::mem::take(&mut *data)));
        }
        Management::RemoveAttachment { entry, attachment } => {
            let source = visible_entry(database, entry)?;
            if source.attachment_by_name(attachment).is_none() {
                return Err("attachment");
            }
            remove_current_attachments(database, source.id(), std::slice::from_ref(attachment))?;
        }
        Management::RestoreHistory { entry, index } => {
            let source = visible_entry(database, entry)?;
            let id = source.id();
            let version = source.historical(*index).ok_or("history")?;
            let fields = version.fields.clone();
            let tags = version.tags.clone();
            let autotype = version.autotype.clone();
            let custom_data = version.custom_data.clone();
            let override_url = version.override_url.clone();
            let foreground_color = version.foreground_color.clone();
            let background_color = version.background_color.clone();
            let quality_check = version.quality_check;
            let icon = version.icon().cloned();
            let remove: Vec<_> = source
                .attachments_named()
                .filter(|(name, data)| {
                    version
                        .attachment_by_name(name)
                        .is_none_or(|old| old.id() != data.id())
                })
                .map(|(name, _)| name.to_owned())
                .collect();
            let add: Vec<_> = version
                .attachments_named()
                .filter(|(name, data)| {
                    source
                        .attachment_by_name(name)
                        .is_none_or(|current| current.id() != data.id())
                })
                .map(|(name, data)| (name.to_owned(), data.data.clone()))
                .collect();
            let update = |entry: &mut EntryMut<'_>| -> Result<(), &'static str> {
                entry.fields = fields;
                entry.tags = tags;
                entry.autotype = autotype;
                entry.custom_data = custom_data;
                entry.override_url = override_url;
                entry.foreground_color = foreground_color;
                entry.background_color = background_color;
                entry.quality_check = quality_check;
                if icon.as_ref() != entry.icon() {
                    match icon {
                        Some(Icon::BuiltIn(id)) => entry.set_icon_builtin(id),
                        Some(Icon::Custom(id)) => {
                            entry.set_icon_custom(id).map_err(|_| "history")?
                        }
                        None => entry.set_icon_none(),
                    }
                }
                for (name, value) in add {
                    entry.add_attachment(name, value);
                }
                entry.times.last_modification = Some(Times::now());
                Ok(())
            };
            if remove.is_empty() {
                let mut entry = database.entry_mut(id).ok_or("entry")?;
                let mut tracked = entry.track_changes();
                update(&mut tracked.as_mut())?;
            } else {
                remove_current_attachments(database, id, &remove)?;
                update(&mut database.entry_mut(id).ok_or("entry")?)?;
            }
        }
        Management::DeleteHistory { entry, index } => {
            let source = visible_entry(database, entry)?;
            let id = source.id();
            source.historical(*index).ok_or("history")?;
            let mut retained = History::default();
            for (position, version) in source
                .history
                .as_ref()
                .ok_or("history")?
                .get_entries()
                .iter()
                .enumerate()
                .rev()
            {
                if position != *index {
                    retained.add_entry(version.clone());
                }
            }
            database.entry_mut(id).ok_or("entry")?.history = Some(retained);
            database.remove_unused_attachments();
        }
        Management::AddGroup { parent, title }
        | Management::RenameGroup {
            group: parent,
            title,
        } => {
            let id = group_id(database, parent)?;
            let title = title.trim();
            if title.is_empty() || title.chars().count() > 128 {
                return Err("group_name");
            }
            let mut group = database.group_mut(id).ok_or("group")?;
            match change {
                Management::AddGroup { .. } => group.add_group().name = title.to_owned(),
                _ => {
                    group.edit_tracking(|tracked| tracked.name = title.to_owned());
                }
            }
        }
        Management::MoveGroup { group, parent } => {
            let id = group_id(database, group)?;
            let parent = group_id(database, parent)?;
            database
                .group_mut(id)
                .ok_or("group")?
                .track_changes()
                .move_to(parent)
                .map_err(|_| "group_move")?;
        }
        Management::TrashGroup { group }
        | Management::RestoreGroup { group }
        | Management::PurgeGroup { group } => {
            let root = database.root().id();
            let bin = database.recycle_bin().map(|group| group.id());
            let from_trash = !matches!(change, Management::TrashGroup { .. });
            let source = database
                .iter_all_groups()
                .find(|candidate| {
                    candidate.id() != root
                        && Some(candidate.id()) != bin
                        && candidate.id().uuid().to_string() == *group
                        && group_path(database, candidate.clone())
                            .is_some_and(|(_, trashed)| trashed == from_trash)
                })
                .ok_or("group")?;
            let id = source.id();
            if matches!(change, Management::PurgeGroup { .. }) {
                database
                    .group_mut(id)
                    .ok_or("group")?
                    .track_changes()
                    .remove()
                    .map_err(|_| "group")?;
            } else {
                let destination = if from_trash {
                    source
                        .previous_parent()
                        .filter(|previous| {
                            group_path(database, previous.clone())
                                .is_some_and(|(_, trashed)| !trashed)
                        })
                        .map_or(root, |previous| previous.id())
                } else {
                    ensure_recycle_bin(database)
                };
                database
                    .group_mut(id)
                    .ok_or("group")?
                    .track_changes()
                    .move_to(destination)
                    .map_err(|_| "group_move")?;
            }
        }
        Management::TrashEntry { entry }
        | Management::RestoreEntry { entry }
        | Management::PurgeEntry { entry } => {
            let from_trash = !matches!(change, Management::TrashEntry { .. });
            let (source, _, _) = entries(database)
                .find(|(candidate, _, trashed)| {
                    *trashed == from_trash && candidate.id().uuid().to_string() == *entry
                })
                .ok_or("entry")?;
            let id = source.id();
            if matches!(change, Management::PurgeEntry { .. }) {
                database
                    .entry_mut(id)
                    .ok_or("entry")?
                    .track_changes()
                    .remove();
                return Ok(());
            }
            let target = if from_trash {
                source
                    .previous_parent()
                    .filter(|group| {
                        group_path(database, group.clone()).is_some_and(|(_, trashed)| !trashed)
                    })
                    .map_or_else(|| database.root().id(), |group| group.id())
            } else {
                ensure_recycle_bin(database)
            };
            database
                .entry_mut(id)
                .ok_or("entry")?
                .track_changes()
                .move_to(target)
                .map_err(|_| "group")?;
        }
    }
    Ok(())
}

fn parse_otp(value: &str) -> Result<keepass::db::TOTP, &'static str> {
    if !value.starts_with("otpauth://totp/") {
        return Err("otp");
    }
    let uri = url::Url::parse(value).map_err(|_| "otp")?;
    let mut otp: keepass::db::TOTP = value.parse().map_err(|_| "otp")?;
    // Provisioning URIs default to six digits. The KDBX library defaults to eight.
    if !uri.query_pairs().any(|(key, _)| key == "digits") {
        otp.digits = 6;
    }
    if otp.period == 0
        || !(6..=8).contains(&otp.digits)
        || Zeroizing::new(otp.get_secret()).is_empty()
    {
        return Err("otp");
    }
    Ok(otp)
}

fn make_key(master: &str, path: Option<&str>) -> Result<DatabaseKey, &'static str> {
    let mut key = DatabaseKey::new();
    if !master.is_empty() {
        key = key.with_password(master);
    }
    if let Some(path) = path {
        let (keyfile, _) = regular_file(path, KEYFILE_LIMIT).map_err(|_| "keyfile")?;
        key = key
            .with_keyfile(&mut keyfile.take(KEYFILE_LIMIT + 1))
            .map_err(|_| "keyfile")?;
    }
    Ok(key)
}

fn open_error_code(error: DatabaseOpenError) -> &'static str {
    use DatabaseFormatError::{Kdbx3, Kdbx4};
    use DatabaseOpenError::Format;

    match error {
        DatabaseOpenError::Io(error) if error.kind() == io::ErrorKind::UnexpectedEof => "incomplete",
        DatabaseOpenError::Io(_) => "database_file",
        DatabaseOpenError::UnexpectedEof
        | Format(Kdbx3(Kdbx3OpenError::OuterHeader(Kdbx3OuterHeaderError::UnexpectedEof)))
        | Format(Kdbx4(Kdbx4OpenError::OuterHeader(Kdbx4OuterHeaderError::UnexpectedEof))) => "incomplete",
        DatabaseOpenError::VersionParse(_) | DatabaseOpenError::UnsupportedVersion => "format",
        Format(Kdbx4(Kdbx4OpenError::HeaderHashMismatch)) => "invalid_header",
        Format(Kdbx4(Kdbx4OpenError::BlockStream(_)))
        | Format(Kdbx3(Kdbx3OpenError::BlockHashMismatch(_))) => "invalid_blocks",
        Format(Kdbx4(Kdbx4OpenError::Xml(ParseXmlError::Unprotect(error))))
        | Format(Kdbx3(Kdbx3OpenError::Xml(ParseXmlError::Unprotect(error)))) => {
            // keepass 0.17 does not export UnprotectError itself. Return only a fixed code.
            let description = error.to_string();
            if description.starts_with("an entry with ID ") {
                "duplicate_entry"
            } else if description.starts_with("a group with ID ") {
                "duplicate_group"
            } else if description.starts_with("Error base64 decoding protected value:") {
                "protected_encoding"
            } else {
                "protected_data"
            }
        }
        Format(Kdbx4(Kdbx4OpenError::Xml(_))) | Format(Kdbx3(Kdbx3OpenError::Xml(_))) => "invalid_xml",
        Format(Kdbx4(Kdbx4OpenError::InnerHeader(_))) => "invalid_inner_header",
        Format(_) => "invalid_data",
        DatabaseOpenError::Key(_) => "unlock",
        _ => "decrypt",
    }
}

fn run(req: &mut Request, output: &mut impl Write) -> Result<(), &'static str> {
    let key = make_key(&req.master, req.keyfile.as_deref());
    req.master.zeroize();
    let key = key?;
    if let Operation::Create { name } = &req.operation {
        let database = Database::new();
        let path = publish(&database, key, Path::new(&req.database), name, || Ok(()))?;
        let metadata = fs::metadata(&path).map_err(|_| "save")?;
        return serde_json::to_writer(
            output,
            &Response::List {
                database: Some(path),
                stamp: stamp(&metadata),
                entries: Vec::new(),
                groups: groups(&database),
                icons: HashMap::new(),
                writable: true,
                backup: None,
            },
        )
        .map_err(|_| "output");
    }
    let (mut file, metadata) =
        regular_file(&req.database, DATABASE_LIMIT).map_err(|_| "database_file")?;
    let current_stamp = stamp(&metadata);
    match &req.operation {
        Operation::Read { stamp, .. }
        | Operation::ReadCustom { stamp, .. }
        | Operation::Rekey { stamp, .. }
        | Operation::Merge { stamp, .. }
        | Operation::Search { stamp, .. }
        | Operation::SaveCopy { stamp, .. }
        | Operation::ManageCopy { stamp, .. }
        | Operation::Inspect { stamp, .. }
        | Operation::Export { stamp, .. }
        | Operation::Preview { stamp, .. }
            if *stamp != current_stamp =>
        {
            return Err("changed");
        }
        _ => {}
    }

    let version = Database::get_version(&mut file).map_err(|error| match error {
        DatabaseOpenError::Io(error) if error.kind() == io::ErrorKind::UnexpectedEof => "incomplete",
        DatabaseOpenError::Io(_) => "database_file",
        _ => "format",
    })?;
    if !matches!(version, DatabaseVersion::KDB3(_) | DatabaseVersion::KDB4(_)) {
        return Err("format");
    }
    file.rewind().map_err(|_| "database_file")?;
    let writable = matches!(version, DatabaseVersion::KDB4(_));
    let save_key = match req.operation {
        Operation::SaveCopy { .. } | Operation::ManageCopy { .. } | Operation::Merge { .. } if writable => Some(key.clone()),
        Operation::Rekey {
            ref new_master,
            ref new_keyfile,
            ..
        } if writable => {
            if (new_master.is_empty() && new_keyfile.is_none())
                || new_master.chars().count() > 1_024
            {
                return Err("new_key");
            }
            Some(make_key(new_master, new_keyfile.as_deref())?)
        }
        Operation::SaveCopy { .. } | Operation::ManageCopy { .. } | Operation::Rekey { .. } | Operation::Merge { .. } => {
            return Err("readonly");
        }
        _ => None,
    };
    let mut database =
        Database::open(&mut file.take(DATABASE_LIMIT + 1), key).map_err(open_error_code)?;
    let latest = fs::metadata(&req.database).map_err(|_| "changed")?;
    if stamp(&latest) != current_stamp {
        return Err("changed");
    }
    if save_key.is_some() && database.config.version == DatabaseVersion::KDB4(0) {
        // The bundled writer emits KDBX 4.1. Keep the source format untouched until a save.
        database.config.version = DatabaseVersion::KDB4(1);
    }
    if let Operation::Merge { remote, .. } = &req.operation {
        let (file, _) = regular_file(remote, DATABASE_LIMIT).map_err(|_| "database_file")?;
        let remote = Database::open(&mut file.take(DATABASE_LIMIT + 1), save_key.as_ref().ok_or("readonly")?.clone())
            .map_err(|_| "merge_remote")?;
        if database.root().id() != remote.root().id() {
            return Err("merge_unrelated");
        }
        if database.meta.recyclebin_uuid.is_some() && remote.meta.recyclebin_uuid.is_some()
            && database.meta.recyclebin_uuid != remote.meta.recyclebin_uuid
        {
            return Err("merge_conflict");
        }
        if remote.meta.recyclebin_changed > database.meta.recyclebin_changed
            || (database.meta.recyclebin_uuid.is_none() && remote.meta.recyclebin_uuid.is_some())
        {
            database.meta.recyclebin_uuid = remote.meta.recyclebin_uuid;
            database.meta.recyclebin_enabled = remote.meta.recyclebin_enabled;
            database.meta.recyclebin_changed = remote.meta.recyclebin_changed;
        }
        if remote.meta.database_name_changed > database.meta.database_name_changed {
            database.meta.database_name = remote.meta.database_name.clone();
            database.meta.database_name_changed = remote.meta.database_name_changed;
        }
        if remote.meta.database_description_changed > database.meta.database_description_changed {
            database.meta.database_description = remote.meta.database_description.clone();
            database.meta.database_description_changed = remote.meta.database_description_changed;
        }
        if remote.meta.default_username_changed > database.meta.default_username_changed {
            database.meta.default_username = remote.meta.default_username.clone();
            database.meta.default_username_changed = remote.meta.default_username_changed;
        }
        let log = database.merge_with_attachments(remote).map_err(|_| "merge_conflict")?;
        if log.warnings.iter().any(|warning| warning.starts_with("Cannot")) {
            return Err("merge_conflict");
        }
    }

    if let Operation::SaveCopy { entry, fields, .. } = &req.operation {
        let id = match entry {
            Some(id) => Some(
                entries(&database)
                    .find(|(candidate, _, trashed)| {
                        !trashed && candidate.id().uuid().to_string() == *id
                    })
                    .map(|(entry, _, _)| entry.id())
                    .ok_or("entry")?,
            ),
            None => None,
        };
        if id.is_none()
            && entries(&database)
                .filter(|(_, _, trashed)| !trashed)
                .count()
                >= ENTRY_LIMIT
        {
            return Err("too_many");
        }
        if let Some(value) = &fields.otp {
            parse_otp(value)?;
        }
        let destination = fields
            .group
            .as_deref()
            .map(|id| group_id(&database, id))
            .transpose()?;
        let mut group;
        let mut entry = match id {
            Some(id) => database.entry_mut(id).ok_or("entry")?,
            None => {
                let target = destination.unwrap_or_else(|| database.root().id());
                group = database.group_mut(target).ok_or("group")?;
                group.add_entry()
            }
        };
        let move_to = id
            .and(destination)
            .filter(|target| *target != entry.as_ref().parent().id());
        let mut entry = entry.track_changes();
        if let Some(target) = move_to {
            entry.move_to(target).map_err(|_| "group")?;
        }
        if let Some(tags) = &fields.tags {
            if tags.len() > 64
                || tags.iter().any(|tag| {
                    tag.is_empty() || tag.chars().count() > 128 || tag.contains([';', ',', '\t'])
                })
            {
                return Err("tags");
            }
            entry.edit(|tracked| tracked.tags.clone_from(tags));
        }
        for (name, value) in [
            (fields::TITLE, &fields.title),
            (fields::USERNAME, &fields.username),
            (fields::URL, &fields.url),
            (fields::NOTES, &fields.notes),
        ] {
            if let Some(value) = value {
                if name == fields::NOTES
                    || entry
                        .fields
                        .get(name)
                        .is_some_and(|value| value.is_protected())
                {
                    entry.set_protected(name, value.as_str());
                } else {
                    entry.set_unprotected(name, value.as_str());
                }
            }
        }
        if let Some(path) = &fields.icon_file {
            entry.set_icon_custom_new(import_icon(path)?);
        } else if let Some(icon) = &fields.icon {
            if icon == "none" {
                entry.set_icon_none();
            } else {
                let icon = icon
                    .parse::<usize>()
                    .ok()
                    .filter(|value| *value < 69)
                    .ok_or("icon_file")?;
                entry.set_icon_builtin(icon);
            }
        }
        if let Some(value) = &fields.color {
            let color = if value.is_empty() {
                None
            } else {
                Some(value.parse().map_err(|_| "color")?)
            };
            entry.edit(|tracked| tracked.background_color = color);
        }
        if let Some(value) = &fields.otp {
            entry.set_protected(fields::OTP, value.as_str());
        }
        if let Some(value) = &fields.password {
            entry.set_protected(fields::PASSWORD, value.as_str());
        }
    }

    if let Operation::ManageCopy { change, .. } = &req.operation {
        manage(&mut database, change)?;
    }

    match &req.operation {
        Operation::Create { .. } => Err("request"),
        Operation::List
        | Operation::Merge { .. }
        | Operation::SaveCopy { .. }
        | Operation::ManageCopy { .. }
        | Operation::Rekey { .. } => {
            let mut active_count = 0;
            let mut trash_count = 0;
            let mut listed = Vec::new();
            let mut icons = HashMap::<String, String>::new();
            let mut icon_budget = 256 * 1024;
            for (entry, group, trashed) in entries(&database) {
                if trashed {
                    trash_count += 1;
                    if trash_count > ENTRY_LIMIT {
                        continue;
                    }
                } else {
                    active_count += 1;
                    if active_count > ENTRY_LIMIT {
                        return Err("too_many");
                    }
                }
                let icon = match entry.icon() {
                    Some(Icon::BuiltIn(index)) => Some(index.to_string()),
                    Some(Icon::Custom(id)) => {
                        let name = id.to_string();
                        if icon_budget > 0
                            && !icons.contains_key(&name)
                            && let Some(data) = entry
                                .custom_icon()
                                .and_then(|icon| stored_icon_image(&icon.data))
                            && data.len() <= icon_budget
                        {
                            icon_budget -= data.len();
                            icons.insert(name.clone(), data);
                        }
                        Some(name)
                    }
                    None => None,
                };
                listed.push(Entry {
                    id: entry.id().uuid().to_string(),
                    title: display(entry.get_title(), 256),
                    username: display(entry.get_username(), 256),
                    url: display(entry.get_url(), 512),
                    group: display(Some(&group), 512),
                    group_id: entry.parent().id().uuid().to_string(),
                    icon,
                    color: entry.background_color.as_ref().map(ToString::to_string),
                    tags: entry.tags.clone(),
                    trashed,
                    has_totp: entry.get_raw_otp_value().is_some(),
                    has_history: entry.historical(0).is_some(),
                    has_attachments: entry.attachments_named().next().is_some(),
                    has_secret: entry.fields.contains_key(fields::PASSWORD),
                    has_notes: entry
                        .get(fields::NOTES)
                        .is_some_and(|note| !note.is_empty()),
                });
            }
            let (saved_database, new_stamp, backup) = match &req.operation {
                Operation::SaveCopy { name, replace, .. }
                | Operation::ManageCopy { name, replace, .. } => {
                    let source = Path::new(&req.database);
                    let key = save_key.ok_or("readonly")?;
                    let (path, backup) = if *replace {
                        let backup = replace_with_backup(&database, key, source, &current_stamp)?;
                        (req.database.clone(), Some(backup))
                    } else {
                        let path =
                            publish(&database, key, source.parent().ok_or("save")?, name, || {
                                if stamp(&fs::metadata(source).map_err(|_| "changed")?)
                                    != current_stamp
                                {
                                    return Err("changed");
                                }
                                Ok(())
                            })?;
                        (path, None)
                    };
                    let metadata = fs::metadata(&path).map_err(|_| "save")?;
                    (Some(path), stamp(&metadata), backup)
                }
                Operation::Rekey { name, .. } | Operation::Merge { name, .. } => {
                    let source = Path::new(&req.database);
                    let path = publish(
                        &database,
                        save_key.ok_or("readonly")?,
                        source.parent().ok_or("save")?,
                        name,
                        || {
                            if stamp(&fs::metadata(source).map_err(|_| "changed")?) != current_stamp
                            {
                                return Err("changed");
                            }
                            Ok(())
                        },
                    )?;
                    let metadata = fs::metadata(&path).map_err(|_| "save")?;
                    (Some(path), stamp(&metadata), None)
                }
                _ => (None, current_stamp, None),
            };
            serde_json::to_writer(
                output,
                &Response::List {
                    stamp: new_stamp,
                    entries: listed,
                    groups: groups(&database),
                    icons,
                    writable,
                    database: saved_database,
                    backup,
                },
            )
            .map_err(|_| "output")
        }
        Operation::Inspect { entry, history, .. } => {
            with_entry_version(&database, entry, *history, |entry| {
                let versions = entry
                    .history
                    .iter()
                    .flat_map(|history| history.get_entries().iter())
                    .enumerate()
                    .map(|(index, version)| {
                        let unprotected = |name| {
                            version
                                .fields
                                .get(name)
                                .filter(|value| !value.is_protected())
                                .map(|value| value.as_str())
                        };
                        Version {
                            index,
                            has_attachments: entry.historical(index).is_some_and(|version| {
                                version.attachments_named().next().is_some()
                            }),
                            title: display(unprotected(fields::TITLE), 256),
                            username: display(unprotected(fields::USERNAME), 256),
                            modified: version
                                .times
                                .last_modification
                                .map(|time| time.and_utc().to_rfc3339()),
                        }
                    })
                    .collect();
                let mut attachments: Vec<_> = entry
                    .attachments_named()
                    .map(|(name, attachment)| AttachmentInfo {
                        name: name.to_owned(),
                        size: attachment.data.len(),
                    })
                    .collect();
                attachments.sort_by(|a, b| a.name.cmp(&b.name));
                let mut custom: Vec<_> = entry
                    .fields
                    .iter()
                    .filter(|(name, _)| custom_field(name))
                    .map(|(name, value)| CustomField {
                        name: name.clone(),
                        protected: value.is_protected(),
                        value: (!value.is_protected())
                            .then(|| display(Some(value.as_str()), 2_000)),
                    })
                    .collect();
                custom.sort_by(|a, b| a.name.cmp(&b.name));
                serde_json::to_writer(
                    output,
                    &Response::Details {
                        versions,
                        attachments,
                        custom,
                    },
                )
                .map_err(|_| "output")
            })
        }
        Operation::Preview {
            entry,
            attachment,
            history,
            ..
        } => with_entry_version(&database, entry, *history, |entry| {
            preview_attachment(entry, attachment, output)
        }),
        Operation::Export {
            entry,
            attachment,
            history,
            directory,
            name,
            ..
        } => {
            with_entry_version(&database, entry, *history, |entry| {
                export_attachment(entry, attachment, directory, name)
            })?;
            serde_json::to_writer(output, &Response::Exported).map_err(|_| "output")
        }
        Operation::Search {
            pattern,
            regex,
            include_protected,
            history,
            trash,
            ..
        } => {
            if pattern.is_empty() || pattern.chars().count() > 512 {
                return Err("search_pattern");
            }
            let escaped;
            let input = if *regex {
                pattern.as_str()
            } else {
                escaped = Zeroizing::new(regex::escape(pattern.as_str()));
                escaped.as_str()
            };
            let expression = RegexBuilder::new(input)
                .case_insensitive(true)
                .size_limit(1 << 20)
                .build()
                .map_err(|_| "search_pattern")?;
            let matches = |entry: &keepass::db::Entry| {
                entry.tags.iter().any(|tag| expression.is_match(tag))
                    || entry.fields.values().any(|value| {
                        (*include_protected || !value.is_protected())
                            && expression.is_match(value.as_str())
                    })
            };
            let ids = entries(&database)
                .filter(|(_, _, trashed)| trashed == trash)
                .filter(|(entry, group, _)| {
                    expression.is_match(group)
                        || matches(entry)
                        || (*history
                            && entry
                                .history
                                .iter()
                                .flat_map(|versions| versions.get_entries())
                                .any(matches))
                })
                .map(|(entry, _, _)| entry.id().uuid().to_string())
                .take(ENTRY_LIMIT)
                .collect();
            serde_json::to_writer(output, &Response::Matches { ids }).map_err(|_| "output")
        }
        Operation::ReadCustom { entry, field, .. } => {
            if !custom_field(field) {
                return Err("field");
            }
            let entry = visible_entry(&database, entry)?;
            let value = entry.get(field).ok_or("field")?;
            serde_json::to_writer(output, &Response::Value { value }).map_err(|_| "output")
        }
        Operation::Read { entry, field, .. } => {
            let (entry, _, _) = entries(&database)
                .find(|(candidate, _, trashed)| {
                    !trashed && candidate.id().uuid().to_string() == *entry
                })
                .ok_or("entry")?;
            let code;
            let value = match field {
                Field::Username => entry.get_username(),
                Field::Password => entry.get_password(),
                Field::Url => entry.get_url(),
                Field::Notes => entry.get(fields::NOTES),
                Field::Totp => {
                    let otp = parse_otp(entry.get_raw_otp_value().ok_or("field")?)?;
                    code = Zeroizing::new(otp.value_now().map_err(|_| "otp")?.code);
                    Some(code.as_str())
                }
            };
            let value = value.filter(|text| !text.is_empty()).ok_or("field")?;
            serde_json::to_writer(output, &Response::Value { value }).map_err(|_| "output")
        }
    }
}

fn main() {
    if std::env::args().nth(1).as_deref() == Some("--oauth-loopback") {
        if oauth::run().is_err() {
            std::process::exit(1);
        }
        return;
    }

    // Avoid forwarding parser internals or file details to the host process on panic.
    std::panic::set_hook(Box::new(|_| {}));
    let mut input = Zeroizing::new(Vec::new());
    let mut output = io::stdout().lock();
    let result = io::stdin()
        .lock()
        .take(65_537)
        .read_to_end(&mut input)
        .map_err(|_| "request")
        .and_then(|count| {
            if count <= 65_536 {
                Ok(())
            } else {
                Err("request")
            }
        })
        .and_then(|()| serde_json::from_slice::<Request>(&input).map_err(|_| "request"));
    input.zeroize();
    let result = result.and_then(|mut request| run(&mut request, &mut output));
    if let Err(code) = result {
        let _ = serde_json::to_writer(&mut output, &Response::Error { code });
    }
    let _ = output.flush();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merging_attachments_preserves_each_side_of_an_id_collision() {
        let mut local = Database::new();
        let entry_id = local.root_mut().add_entry().id();
        let mut remote = local.clone();
        {
            let mut entry = local.entry_mut(entry_id).unwrap();
            entry.set_unprotected(fields::TITLE, "Local");
            entry.times.last_modification = Some(Times::epoch());
            entry.add_attachment("proof.bin", Value::protected(vec![1]));
        }
        {
            let mut entry = remote.entry_mut(entry_id).unwrap();
            entry.set_unprotected(fields::TITLE, "Remote");
            entry.times.last_modification = Some(Times::now());
            entry.add_attachment("proof.bin", Value::protected(vec![2]));
        }
        local.merge_with_attachments(remote).unwrap();
        let key = DatabaseKey::new().with_password("fixture-merge-key");
        let mut bytes = Vec::new();
        local.save(&mut bytes, key.clone()).unwrap();
        let saved = Database::open(&mut Cursor::new(bytes), key).unwrap();
        let current = saved.entry(entry_id).unwrap();
        let prior = current.historical(0).unwrap();
        assert_eq!(current.get_title(), Some("Remote"));
        assert_eq!(prior.get_title(), Some("Local"));
        assert_eq!(current.attachment_by_name("proof.bin").unwrap().data.as_slice(), &[2]);
        assert_eq!(prior.attachment_by_name("proof.bin").unwrap().data.as_slice(), &[1]);
    }

    #[test]
    fn removing_current_attachment_preserves_old_versions_after_reopen() {
        let mut database = Database::new();
        let id = {
            let mut root = database.root_mut();
            let mut entry = root.add_entry();
            entry.add_attachment("sample.bin", Value::protected(vec![0, 127, 255]));
            entry.id()
        };
        database
            .entry_mut(id)
            .unwrap()
            .track_changes()
            .set_unprotected(fields::TITLE, "Updated");
        remove_current_attachments(&mut database, id, &["sample.bin".into()]).unwrap();

        let key = DatabaseKey::new().with_password("fixture-attachment-key");
        let mut encrypted = Vec::new();
        database.save(&mut encrypted, key.clone()).unwrap();
        let reopened = Database::open(&mut Cursor::new(encrypted), key).unwrap();
        let entry = reopened.entry(id).unwrap();
        assert!(entry.attachment_by_name("sample.bin").is_none());
        for index in 0..2 {
            let version = entry.historical(index).unwrap();
            let attachment = version.attachment_by_name("sample.bin").unwrap();
            assert_eq!(attachment.data.as_slice(), &[0, 127, 255]);
        }
        assert_eq!(reopened.iter_all_entries().count(), 1);
    }

    #[test]
    fn replacing_a_vault_retains_the_exact_encrypted_original_and_rejects_stale_saves() {
        let directory = std::env::temp_dir().join(format!(
            "tinycast-kdbx-test-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&directory).unwrap();
        struct TestDirectory(PathBuf);
        impl Drop for TestDirectory {
            fn drop(&mut self) {
                let _ = fs::remove_dir_all(&self.0);
            }
        }
        let _directory = TestDirectory(directory.clone());
        let path = directory.join("vault.kdbx");
        let key = DatabaseKey::new().with_password("fixture-backup-key");
        let mut original = Vec::new();
        Database::new().save(&mut original, key.clone()).unwrap();
        fs::write(&path, &original).unwrap();
        let stamp_before = stamp(&fs::metadata(&path).unwrap());

        let mut edited = Database::new();
        edited
            .root_mut()
            .add_entry()
            .set_unprotected(fields::TITLE, "Edited");
        let backup = replace_with_backup(&edited, key.clone(), &path, &stamp_before).unwrap();
        assert_eq!(fs::read(backup).unwrap(), original);
        assert_eq!(
            replace_with_backup(&edited, key.clone(), &path, &stamp_before),
            Err("changed")
        );
        let saved = Database::open(&mut File::open(&path).unwrap(), key).unwrap();
        assert_eq!(
            saved.iter_all_entries().next().unwrap().get_title(),
            Some("Edited")
        );
    }
}
