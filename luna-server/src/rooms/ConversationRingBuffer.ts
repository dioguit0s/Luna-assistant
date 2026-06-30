import type { ConversationTurn } from '../providers/types.js';

const MAX_TURNS = 10;
const TTL_MS = 5 * 60 * 1000;
const EVICTION_INTERVAL_MS = 60_000;

interface RoomState {
  turns: ConversationTurn[];
  lastActivity: number;
}

export class ConversationRingBuffer {
  private readonly rooms = new Map<string, RoomState>();
  private evictionTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.evictionTimer = setInterval(() => this.evictExpired(), EVICTION_INTERVAL_MS);
  }

  touch(roomId: string): void {
    const state = this.getOrCreate(roomId);
    state.lastActivity = Date.now();
  }

  getHistory(roomId: string): ConversationTurn[] {
    this.evictRoomIfExpired(roomId);
    const state = this.rooms.get(roomId);
    return state ? [...state.turns] : [];
  }

  appendTurn(roomId: string, userText: string, assistantText: string): void {
    const state = this.getOrCreate(roomId);
    const now = Date.now();
    state.lastActivity = now;

    if (userText) {
      state.turns.push({ role: 'user', text: userText, timestamp: now });
    }
    if (assistantText) {
      state.turns.push({ role: 'assistant', text: assistantText, timestamp: now });
    }

    while (state.turns.length > MAX_TURNS * 2) {
      state.turns.shift();
    }
  }

  clear(roomId: string): void {
    this.rooms.delete(roomId);
  }

  hasRoom(roomId: string): boolean {
    this.evictRoomIfExpired(roomId);
    return this.rooms.has(roomId);
  }

  destroy(): void {
    if (this.evictionTimer) {
      clearInterval(this.evictionTimer);
      this.evictionTimer = null;
    }
    this.rooms.clear();
  }

  private getOrCreate(roomId: string): RoomState {
    this.evictRoomIfExpired(roomId);
    let state = this.rooms.get(roomId);
    if (!state) {
      state = { turns: [], lastActivity: Date.now() };
      this.rooms.set(roomId, state);
    }
    return state;
  }

  private evictRoomIfExpired(roomId: string): void {
    const state = this.rooms.get(roomId);
    if (state && Date.now() - state.lastActivity > TTL_MS) {
      this.rooms.delete(roomId);
    }
  }

  private evictExpired(): void {
    const now = Date.now();
    for (const [roomId, state] of this.rooms) {
      if (now - state.lastActivity > TTL_MS) {
        this.rooms.delete(roomId);
      }
    }
  }
}
