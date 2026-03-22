# Changelog

## [Unreleased]

### Added

- Added `pi-channel`, a standalone channel bridge package for `pi` that accepts inbound messages over HTTP or Socket.IO, persists per-channel session state, and exposes a `channel_reply` extension tool for outbound replies.

### Changed

- Changed `pi-channel` to fall back to the last assistant text for outbound delivery when a channel turn completes without a successful `channel_reply` tool call.
- Changed `@mariozechner/pi-channel` to include an `npm run start:local` script for monorepo development with the local `pi` CLI build.
