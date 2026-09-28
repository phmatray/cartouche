// The browser's side of rcheevos' rc_client (see build.sh and src/lib/ra-client.ts): memory reads, server calls,
// events and async results all go through the JS functions below (Module.ra*, set by ra-client.ts).
#include <emscripten.h>
#include <stdlib.h>
#include "rc_client.h"

EM_JS(int, js_read, (uint32_t addr), { return Module.raRead(addr); });
EM_JS(void, js_call, (const char* url, const char* post, int id), {
  Module.raCall(UTF8ToString(url), post ? UTF8ToString(post) : "", id);
});
EM_JS(void, js_event, (int type, int id, const char* title, const char* desc, int points, const char* badge, const char* err), {
  Module.raEvent(type, id, title ? UTF8ToString(title) : "", desc ? UTF8ToString(desc) : "", points, badge ? UTF8ToString(badge) : "", err ? UTF8ToString(err) : "");
});
EM_JS(void, js_done, (int what, int result, const char* msg), { Module.raDone(what, result, msg ? UTF8ToString(msg) : ""); });

static rc_client_t* client;

static uint32_t read_memory(uint32_t address, uint8_t* buffer, uint32_t num_bytes, rc_client_t* c) {
  for (uint32_t i = 0; i < num_bytes; i++) buffer[i] = (uint8_t)js_read(address + i);
  return num_bytes;
}

// Pending server calls, answered by ra_respond(id, ...).
#define CALLS 64
static struct { rc_client_server_callback_t cb; void* data; } calls[CALLS];
static int next_call;
static void server_call(const rc_api_request_t* request, rc_client_server_callback_t cb, void* data, rc_client_t* c) {
  int id = next_call++ % CALLS;
  calls[id].cb = cb; calls[id].data = data;
  js_call(request->url, request->post_data, id);
}
EMSCRIPTEN_KEEPALIVE void ra_respond(int id, const char* body, int len, int status) {
  rc_api_server_response_t r = { body, (size_t)len, status };
  rc_client_server_callback_t cb = calls[id].cb;
  calls[id].cb = NULL;
  if (cb) cb(&r, calls[id].data);
}

static void on_event(const rc_client_event_t* e, rc_client_t* c) {
  const rc_client_achievement_t* a = e->achievement;
  js_event(e->type, a ? (int)a->id : 0, a ? a->title : NULL, a ? a->description : NULL, a ? (int)a->points : 0,
           a ? a->badge_url : NULL, e->server_error ? e->server_error->error_message : NULL);
}

// what: 1 login, 2 game load.
static void on_login(int result, const char* msg, rc_client_t* c, void* u) { js_done(1, result, msg); }
static void on_load(int result, const char* msg, rc_client_t* c, void* u) { js_done(2, result, msg); }

EMSCRIPTEN_KEEPALIVE void ra_init(int hardcore) {
  if (!client) {
    client = rc_client_create(read_memory, server_call);
    rc_client_set_event_handler(client, on_event);
  }
  rc_client_set_hardcore_enabled(client, hardcore);
}
EMSCRIPTEN_KEEPALIVE void ra_login_password(const char* user, const char* pass) { rc_client_begin_login_with_password(client, user, pass, on_login, NULL); }
EMSCRIPTEN_KEEPALIVE void ra_login_token(const char* user, const char* token) { rc_client_begin_login_with_token(client, user, token, on_login, NULL); }
EMSCRIPTEN_KEEPALIVE const char* ra_user_name(void) { const rc_client_user_t* u = rc_client_get_user_info(client); return u ? u->username : NULL; }
EMSCRIPTEN_KEEPALIVE const char* ra_user_token(void) { const rc_client_user_t* u = rc_client_get_user_info(client); return u ? u->token : NULL; }
EMSCRIPTEN_KEEPALIVE void ra_load(const char* hash) { rc_client_begin_load_game(client, hash, on_load, NULL); }
EMSCRIPTEN_KEEPALIVE int ra_game_id(void) { const rc_client_game_t* g = rc_client_get_game_info(client); return g ? (int)g->id : 0; }
/** [achievements, unlocked, points, points unlocked] of the loaded game, at `out`. */
EMSCRIPTEN_KEEPALIVE void ra_summary(uint32_t* out) {
  rc_client_user_game_summary_t s;
  rc_client_get_user_game_summary(client, &s);
  out[0] = s.num_core_achievements; out[1] = s.num_unlocked_achievements; out[2] = s.points_core; out[3] = s.points_unlocked;
}
EMSCRIPTEN_KEEPALIVE void ra_frame(void) { rc_client_do_frame(client); }
EMSCRIPTEN_KEEPALIVE void ra_idle(void) { rc_client_idle(client); }
EMSCRIPTEN_KEEPALIVE void ra_reset(void) { rc_client_reset(client); }
/** A save state or rewind jumped: every achievement starts watching again from here (no hit counts from elsewhere). */
EMSCRIPTEN_KEEPALIVE void ra_jumped(void) { rc_client_deserialize_progress_sized(client, NULL, 0); }
EMSCRIPTEN_KEEPALIVE void ra_unload(void) { rc_client_unload_game(client); }
