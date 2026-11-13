import { applyPlaylist } from "../../src/pipeline.js";
const config = JSON.parse(process.argv[2]);
const tracks = new Set();
await applyPlaylist(config, { execute: true, writeAdapter: {
  backend: "official",
  async validateSession() {
    process.send("locked");
    await new Promise((resolve) => process.once("message", resolve));
    return { storefront: "kr" };
  },
  async validateCatalogSongs(ids) { return ids; },
  async createLibraryPlaylist() { return { id: "p.child" }; },
  async getLibraryPlaylist() { return { canEdit: true }; },
  async getPlaylistTracks() { return [...tracks].map((catalog_id) => ({ catalog_id })); },
  async addTracks(_, ids) { for (const id of ids) tracks.add(id); }
} });
process.disconnect();
