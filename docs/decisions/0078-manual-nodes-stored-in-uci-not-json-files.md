# Manual nodes stored in UCI, not JSON files

All user-entered data lives in UCI (`/etc/config/prism`, sections of type `node`). Subscription nodes (fetched from URLs, potentially hundreds) stay in `/etc/prism/nodes/<sub_id>.json` — storing them in UCI would be impractical. `build-config` reads UCI `node` sections first, then subscription JSON files; first-seen-wins deduplication means manual nodes always override subscription nodes with the same tag.
