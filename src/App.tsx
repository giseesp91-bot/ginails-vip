import React, { useState, useEffect, useRef, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { auth, db, googleProvider } from './firebase';
import {
  signInWithPopup, signOut, onAuthStateChanged, type User
} from 'firebase/auth';
import {
  doc, getDoc, setDoc, deleteDoc, collection, getDocs, writeBatch
} from 'firebase/firestore';
import {
  Plus, Search, Settings, Moon, Sun, Trash2, Edit3, Share2, Download,
  QrCode, Sparkles, Heart, Gem, Leaf, Droplet, Star, Flower2, Award,
  TrendingUp, Users, CheckCircle2, X, ChevronRight, Camera, Palette,
  Filter, BarChart3, Gift, Crown, ArrowLeft, Calendar,
  Bell, Activity, Zap, AlertTriangle, MessageCircle, Clock, Trophy,
} from 'lucide-react';

// ╔═════════════════════════════════════════════════════════════════╗
// ║                                                                 ║
// ║   GINAILS VIP — MODULAR ARCHITECTURE v2                         ║
// ║                                                                 ║
// ║   Designed to run standalone TODAY, and plug into a larger      ║
// ║   cosmetology admin app TOMORROW without touching the UI.       ║
// ║                                                                 ║
// ║   When migrating to a real multi-file project, each numbered    ║
// ║   section below becomes its own file:                           ║
// ║                                                                 ║
// ║     1. types/                  → all interfaces                 ║
// ║     2. constants/              → brand defaults, palettes       ║
// ║     3. adapters/storage.ts     → swappable persistence          ║
// ║     4. services/               → business logic (pure)          ║
// ║     5. hooks/useVIPModule.ts   → single UI integration point    ║
// ║     6. components/             → presentational only            ║
// ║                                                                 ║
// ╚═════════════════════════════════════════════════════════════════╝

// ═══════════════════════════════════════════════════════════════════
// 1. TYPES — Public contract of the VIP module
// ═══════════════════════════════════════════════════════════════════
type Brand = 'rosa' | 'verde';
type Template = 'elegante' | 'minimalista' | 'glam' | 'neutra' | 'moderna';
type StampIcon = 'heart' | 'gem' | 'star' | 'flower' | 'leaf' | 'droplet' | 'sparkle' | 'crown';

// Future-proof: when the parent app sends clients from facial/spa modules,
// they all flow through the same VIP system with this category tag.
type Category = 'nails' | 'facial' | 'corporal' | 'spa' | 'mixed';

// CRM — client behavior states. One per client at any moment.
type ClientState =
  | 'new'           // Sin visitas o muy reciente
  | 'active'        // Viniendo normalmente
  | 'frequent'      // Cliente frecuente (umbral configurable)
  | 'near_reward'   // Le falta 1-2 visitas para el premio
  | 'inactive'      // No viene hace X días (alerta amarilla)
  | 'dormant'       // No viene hace mucho (alerta roja)
  | 'vip_top';      // Completó al menos un premio y sigue viniendo

// CRM thresholds — fully configurable from Settings.
interface CRMThresholds {
  inactiveDays: number;       // Default 30
  dormantDays: number;        // Default 90
  frequentVisitsIn60d: number; // Default 3
  nearRewardRemaining: number; // Default 2 (1 or 2 visits left = near)
}

const DEFAULT_CRM_THRESHOLDS: CRMThresholds = {
  inactiveDays: 30,
  dormantDays: 90,
  frequentVisitsIn60d: 3,
  nearRewardRemaining: 2,
};

// A computed alert. The CRM emits one per client that needs attention.
interface CRMAlert {
  clientId: string;
  state: ClientState;
  priority: 1 | 2 | 3; // 1 = highest (urgent), 3 = lowest (informational)
  daysSinceLastVisit: number | null;
  visitsRemaining: number;
  reason: string; // Human-readable, used in UI
  whatsappTemplate: string; // Pre-filled message for the operator
}

interface Visit {
  date: string; // ISO
  note?: string;
  // Hook for future integration: link a visit to an appointment in the parent CRM
  appointmentId?: string;
  // Stamp used for THIS specific visit. Lets a single card show mixed services
  // (e.g., a nail visit + a facial visit on the same loyalty card).
  // Can be a built-in icon, an emoji, or a custom uploaded stamp ID.
  stamp?: VisitStamp;
}

// Per-visit stamp identity. Three flavors:
//  - { kind: 'icon', id: StampIcon }      → built-in lucide icon
//  - { kind: 'emoji', char: '💅' }         → any emoji
//  - { kind: 'custom', id: 'cs_abc123' }  → custom uploaded image (in settings.customStamps)
type VisitStamp =
  | { kind: 'icon'; id: StampIcon }
  | { kind: 'emoji'; char: string }
  | { kind: 'custom'; id: string };

// A custom stamp uploaded by the user — small logo/image used as a sello
interface CustomStamp {
  id: string;
  label: string;          // "Logo Rosa", "Logo Verde", "Manicura", etc.
  image: string;          // base64 data URL
  createdAt: string;
}

interface Client {
  id: string;
  name: string;
  phone?: string;
  photo?: string;
  notes?: string;
  brand: Brand;
  category?: Category; // optional — defaults derived from brand
  template: Template;
  stampIcon: StampIcon;
  goal: number;
  visits: Visit[];
  rewardClaimed: boolean;
  createdAt: string;
  // Hook for future integration: external client ID from the parent CRM
  externalId?: string;
  // Hook: which sub-tenant in a multi-business deployment
  tenantId?: string;
}

interface BrandConfig {
  businessName: string;
  rewardText: string;
  logo: string | null; // base64 data URL
  primary: string;
  primaryDark: string;
  accent: string;
  bg: string;
  textTone: string;
}

interface Settings {
  rosa: BrandConfig;
  verde: BrandConfig;
  darkMode: boolean;
  // User-uploaded stamps that can be picked per-visit.
  // Lets a single card mix services (e.g., one logo for nails, one for facial).
  customStamps?: CustomStamp[];
  // Optional subtitle shown under the business name on the card.
  // Empty string = no subtitle (default — keeps the card minimal).
  cardSubtitle?: string;
  // CRM thresholds (configurable, defaults provided)
  crmThresholds?: CRMThresholds;
  // Legacy fields for v1 → v2 migration
  businessNameRosa?: string;
  businessNameVerde?: string;
  rewardTextRosa?: string;
  rewardTextVerde?: string;
}

// ─── Public events the VIP module emits ───
// The parent app subscribes to these to react (e.g., notify CRM, send email).
interface VIPEvents {
  onClientCreated?: (client: Client) => void;
  onClientUpdated?: (client: Client) => void;
  onClientDeleted?: (clientId: string) => void;
  onVisitAdded?: (client: Client, visit: Visit) => void;
  onVisitRemoved?: (client: Client) => void;
  onRewardCompleted?: (client: Client) => void;
  onRewardClaimed?: (client: Client) => void;
  // CRM hook: emitted when alerts are recomputed (parent app can sync to CRM)
  onAlertsComputed?: (alerts: CRMAlert[]) => void;
}

// ─── Public configuration for embedding the VIP module ───
// If undefined, the module runs standalone with localStorage (current MVP).
// If provided, the parent app controls persistence and gets event hooks.
interface VIPModuleConfig {
  storageAdapter?: StorageAdapter;
  events?: VIPEvents;
  // The parent can preload clients (e.g., from its own CRM database)
  initialClients?: Client[];
  // The parent can lock the module to a single brand/category context
  lockedBrand?: Brand;
  lockedCategory?: Category;
  // Read-only mode for embedding in dashboards
  readOnly?: boolean;
  // Tenant scoping for multi-business deployments
  tenantId?: string;
}

// ═══════════════════════════════════════════════════════════════════
// 2. CONSTANTS — Brand defaults & curated palettes
// ═══════════════════════════════════════════════════════════════════
const STORAGE_KEY = 'ginails_vip_clients_v1';
const SETTINGS_KEY = 'ginails_vip_settings_v1';
const SCHEMA_VERSION = 2;

const DEFAULT_BRAND_CONFIG: Record<Brand, BrandConfig> = {
  rosa: {
    businessName: 'Ginails',
    rewardText: 'Manicura semipermanente de regalo',
    logo: null,
    primary: '#E8B4C0',
    primaryDark: '#C98AA0',
    accent: '#D4AF7F',
    bg: '#FDF6F3',
    textTone: '#3D2A2E',
  },
  verde: {
    businessName: 'Ginails',
    rewardText: 'Sesión facial de cortesía',
    logo: null,
    primary: '#B8C9A8',
    primaryDark: '#8FA378',
    accent: '#C4A574',
    bg: '#F5F3EC',
    textTone: '#2E3A2E',
  },
};

const COLOR_PALETTES: { name: string; brand: Brand; primary: string; primaryDark: string; accent: string; bg: string; textTone: string }[] = [
  { name: 'Rosa Empolvado', brand: 'rosa', primary: '#E8B4C0', primaryDark: '#C98AA0', accent: '#D4AF7F', bg: '#FDF6F3', textTone: '#3D2A2E' },
  { name: 'Nude Champagne', brand: 'rosa', primary: '#E8D4C4', primaryDark: '#C9A88E', accent: '#B8924E', bg: '#FAF3EE', textTone: '#3D2D24' },
  { name: 'Coral Boutique', brand: 'rosa', primary: '#F2B8A8', primaryDark: '#D4897A', accent: '#C9A85B', bg: '#FBF2EE', textTone: '#3D2520' },
  { name: 'Lila Suave', brand: 'rosa', primary: '#D8C4DA', primaryDark: '#A88DAA', accent: '#C9A574', bg: '#F8F3F8', textTone: '#332838' },
  { name: 'Salvia Spa', brand: 'verde', primary: '#B8C9A8', primaryDark: '#8FA378', accent: '#C4A574', bg: '#F5F3EC', textTone: '#2E3A2E' },
  { name: 'Eucalipto Zen', brand: 'verde', primary: '#A8C4B8', primaryDark: '#7AA88E', accent: '#B89A6E', bg: '#F1F5F0', textTone: '#28382E' },
  { name: 'Oliva Botánico', brand: 'verde', primary: '#C4C8A0', primaryDark: '#9AA070', accent: '#A8884E', bg: '#F4F3E8', textTone: '#2E2E1F' },
  { name: 'Menta Crema', brand: 'verde', primary: '#C8DDD0', primaryDark: '#8FB89E', accent: '#C4A574', bg: '#F0F5F2', textTone: '#1F3328' },
];

// Map Brand → default Category (so parent app integrations can route clients)
const BRAND_TO_CATEGORY: Record<Brand, Category> = {
  rosa: 'nails',
  verde: 'facial',
};

// ═══════════════════════════════════════════════════════════════════
// 3. STORAGE ADAPTER — Swappable persistence layer
// ═══════════════════════════════════════════════════════════════════
// Today: LocalStorageAdapter (default).
// Tomorrow: implement FirebaseAdapter / RestApiAdapter / SupabaseAdapter
// without touching anything else.
//
// Just pass it via VIPModuleConfig.storageAdapter prop.
//
interface StorageAdapter {
  loadClients(): Promise<Client[]>;
  saveClients(clients: Client[]): Promise<void>;
  loadSettings(): Promise<Settings | null>;
  saveSettings(settings: Settings): Promise<void>;
  // Optional: read a single client by ID (used by the public QR view)
  loadClientById?(id: string): Promise<Client | null>;
}

// Recursively strip undefined values from an object/array.
// Firestore rejects `undefined` as a field value, but JavaScript objects
// often have undefined for optional fields (e.g. phone, notes, photo).
// This converts them to "field omitted" before saving.
function stripUndefined<T>(obj: T): T {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) {
    return obj.map(stripUndefined) as any;
  }
  if (typeof obj === 'object') {
    const out: any = {};
    for (const key of Object.keys(obj as any)) {
      const val = (obj as any)[key];
      if (val !== undefined) {
        out[key] = stripUndefined(val);
      }
    }
    return out;
  }
  return obj;
}

class LocalStorageAdapter implements StorageAdapter {
  async loadClients(): Promise<Client[]> {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch { return []; }
  }
  async saveClients(clients: Client[]): Promise<void> {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(clients)); } catch {}
  }
  async loadSettings(): Promise<Settings | null> {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }
  async saveSettings(settings: Settings): Promise<void> {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch {}
  }
}

// ─── FirebaseAdapter — production persistence with multi-device sync ───
// Each user (Google account) gets their own isolated namespace in Firestore.
// Data lives at: usuarios/{uid}/vip_clientas/* and usuarios/{uid}/vip_settings/main
class FirebaseAdapter implements StorageAdapter {
  constructor(private uid: string) {}

  private clientsCol() {
    return collection(db, 'usuarios', this.uid, 'vip_clientas');
  }
  private settingsDoc() {
    return doc(db, 'usuarios', this.uid, 'vip_settings', 'main');
  }

  async loadClients(): Promise<Client[]> {
    try {
      const snap = await getDocs(this.clientsCol());
      return snap.docs.map(d => d.data() as Client);
    } catch (err) {
      console.error('FirebaseAdapter.loadClients', err);
      return [];
    }
  }

  async saveClients(clients: Client[]): Promise<void> {
    try {
      const batch = writeBatch(db);
      const existing = await getDocs(this.clientsCol());
      existing.forEach(d => batch.delete(d.ref));
      clients.forEach(c => {
        const ref = doc(db, 'usuarios', this.uid, 'vip_clientas', c.id);
        // Firestore rejects `undefined` values. Strip them recursively before saving.
        batch.set(ref, stripUndefined(c));
      });
      await batch.commit();
    } catch (err) {
      console.error('FirebaseAdapter.saveClients', err);
    }
  }

  async loadSettings(): Promise<Settings | null> {
    try {
      const snap = await getDoc(this.settingsDoc());
      return snap.exists() ? (snap.data() as Settings) : null;
    } catch (err) {
      console.error('FirebaseAdapter.loadSettings', err);
      return null;
    }
  }

  async saveSettings(settings: Settings): Promise<void> {
    try {
      await setDoc(this.settingsDoc(), stripUndefined(settings));
    } catch (err) {
      console.error('FirebaseAdapter.saveSettings', err);
    }
  }

  // Public read-only lookup by UID/ID combo. Used by the public card view.
  // Path: usuarios/{ownerUid}/vip_clientas/{clientId}
  static async loadPublicCard(ownerUid: string, clientId: string): Promise<Client | null> {
    try {
      const ref = doc(db, 'usuarios', ownerUid, 'vip_clientas', clientId);
      const snap = await getDoc(ref);
      return snap.exists() ? (snap.data() as Client) : null;
    } catch (err) {
      console.error('FirebaseAdapter.loadPublicCard', err);
      return null;
    }
  }

  static async loadPublicSettings(ownerUid: string): Promise<Settings | null> {
    try {
      const ref = doc(db, 'usuarios', ownerUid, 'vip_settings', 'main');
      const snap = await getDoc(ref);
      return snap.exists() ? (snap.data() as Settings) : null;
    } catch (err) {
      console.error('FirebaseAdapter.loadPublicSettings', err);
      return null;
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// 4. SERVICES — Pure business logic, no React, no DOM
// ═══════════════════════════════════════════════════════════════════
// These are pure functions. They take state in, return new state.
// Easy to test, easy to reuse from a Node backend, easy to share with
// the parent app's mobile/desktop versions.
//
// IMPORTANT: services NEVER call setState directly. The hook orchestrates.

// ─── ID generator ───
const generateId = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

// ─── clientService ───
const clientService = {
  create(input: Omit<Client, 'id' | 'visits' | 'rewardClaimed' | 'createdAt'>): Client {
    return {
      ...input,
      id: generateId(),
      visits: [],
      rewardClaimed: false,
      createdAt: new Date().toISOString(),
      category: input.category ?? BRAND_TO_CATEGORY[input.brand],
    };
  },
  update(client: Client, patch: Partial<Client>): Client {
    return { ...client, ...patch };
  },
  isComplete(client: Client): boolean {
    return client.visits.length >= client.goal;
  },
  progressPercent(client: Client): number {
    return Math.min(100, (client.visits.length / client.goal) * 100);
  },
  remainingVisits(client: Client): number {
    return Math.max(0, client.goal - client.visits.length);
  },
};

// ─── visitService ───
const visitService = {
  add(client: Client, options?: { appointmentId?: string; note?: string; stamp?: VisitStamp; date?: string }): Client {
    if (clientService.isComplete(client)) return client; // can't exceed goal
    const newVisit: Visit = {
      date: options?.date || new Date().toISOString(),
      ...(options?.appointmentId ? { appointmentId: options.appointmentId } : {}),
      ...(options?.note ? { note: options.note } : {}),
      ...(options?.stamp ? { stamp: options.stamp } : {}),
    };
    // Insert keeping chronological order so the stamps grid reflects the timeline
    const newVisits = [...client.visits, newVisit].sort(
      (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
    );
    return { ...client, visits: newVisits };
  },
  removeLast(client: Client): Client {
    return { ...client, visits: client.visits.slice(0, -1) };
  },
  // Edit a single visit (used for date corrections, note changes, etc.)
  updateAt(client: Client, index: number, patch: Partial<Visit>): Client {
    if (index < 0 || index >= client.visits.length) return client;
    const updated = client.visits.map((v, i) => i === index ? { ...v, ...patch } : v);
    // Re-sort if the date was changed so the stamp grid stays chronological
    if (patch.date !== undefined) {
      updated.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
    }
    return { ...client, visits: updated };
  },
  // Remove a specific visit by index (not just the last one)
  removeAt(client: Client, index: number): Client {
    if (index < 0 || index >= client.visits.length) return client;
    return { ...client, visits: client.visits.filter((_, i) => i !== index) };
  },
  toggleRewardClaimed(client: Client): Client {
    return { ...client, rewardClaimed: !client.rewardClaimed };
  },
};

// ─── settingsService ───
const settingsService = {
  defaults(): Settings {
    return {
      rosa: { ...DEFAULT_BRAND_CONFIG.rosa },
      verde: { ...DEFAULT_BRAND_CONFIG.verde },
      darkMode: false,
      customStamps: [],
      cardSubtitle: '',
      crmThresholds: { ...DEFAULT_CRM_THRESHOLDS },
    };
  },
  // Migration v1 (flat fields) → v2 (nested per brand)
  migrate(raw: any): Settings {
    if (!raw) return settingsService.defaults();
    if (raw.businessNameRosa !== undefined && !raw.rosa) {
      return {
        rosa: {
          ...DEFAULT_BRAND_CONFIG.rosa,
          businessName: raw.businessNameRosa || DEFAULT_BRAND_CONFIG.rosa.businessName,
          rewardText: raw.rewardTextRosa || DEFAULT_BRAND_CONFIG.rosa.rewardText,
        },
        verde: {
          ...DEFAULT_BRAND_CONFIG.verde,
          businessName: raw.businessNameVerde || DEFAULT_BRAND_CONFIG.verde.businessName,
          rewardText: raw.rewardTextVerde || DEFAULT_BRAND_CONFIG.verde.rewardText,
        },
        darkMode: !!raw.darkMode,
        customStamps: [],
        cardSubtitle: '',
        crmThresholds: { ...DEFAULT_CRM_THRESHOLDS },
      };
    }
    return {
      rosa: { ...DEFAULT_BRAND_CONFIG.rosa, ...(raw.rosa || {}) },
      verde: { ...DEFAULT_BRAND_CONFIG.verde, ...(raw.verde || {}) },
      darkMode: !!raw.darkMode,
      customStamps: Array.isArray(raw.customStamps) ? raw.customStamps : [],
      cardSubtitle: typeof raw.cardSubtitle === 'string' ? raw.cardSubtitle : '',
      crmThresholds: { ...DEFAULT_CRM_THRESHOLDS, ...(raw.crmThresholds || {}) },
    };
  },
};

// ─── statsService — pure stat calculations ───
const statsService = {
  compute(clients: Client[]) {
    const total = clients.length;
    const active = clients.filter(c => !clientService.isComplete(c)).length;
    const completed = clients.filter(c => clientService.isComplete(c)).length;
    const totalVisits = clients.reduce((s, c) => s + c.visits.length, 0);
    const rosaCount = clients.filter(c => c.brand === 'rosa').length;
    const verdeCount = clients.filter(c => c.brand === 'verde').length;
    const avgVisits = total ? (totalVisits / total).toFixed(1) : '0';
    return { total, active, completed, totalVisits, rosaCount, verdeCount, avgVisits };
  },
  // Filter for the dashboard
  filter(clients: Client[], filters: { search?: string; brand?: 'all' | Brand; status?: 'all' | 'active' | 'complete' }): Client[] {
    return clients.filter(c => {
      if (filters.search && !c.name.toLowerCase().includes(filters.search.toLowerCase())) return false;
      if (filters.brand && filters.brand !== 'all' && c.brand !== filters.brand) return false;
      const isComplete = clientService.isComplete(c);
      if (filters.status === 'active' && isComplete) return false;
      if (filters.status === 'complete' && !isComplete) return false;
      return true;
    });
  },
};

// ─── shareService — message generation, QR, CSV ───
const shareService = {
  whatsappMessage(client: Client, businessName: string, rewardText: string): string {
    const completed = client.visits.length;
    const remaining = client.goal - completed;
    const isComplete = clientService.isComplete(client);
    return isComplete
      ? `✨ ¡${client.name}! Tu tarjeta VIP de ${businessName} está completa. Te ganaste tu premio: ${rewardText} 💖`
      : `✨ Hola ${client.name}! Tu tarjeta VIP de ${businessName}: ${completed}/${client.goal} visitas. Te faltan ${remaining} para tu premio 💖`;
  },
  whatsappUrl(client: Client, message: string): string {
    const phone = (client.phone || '').replace(/\D/g, '');
    return phone
      ? `https://wa.me/${phone}?text=${encodeURIComponent(message)}`
      : `https://wa.me/?text=${encodeURIComponent(message)}`;
  },
  qrUrl(client: Client, primaryDarkHex: string, bgHex: string, baseUrl = 'https://ginails.app/vip'): string {
    return `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(`${baseUrl}/${client.id}`)}&color=${primaryDarkHex.slice(1)}&bgcolor=${bgHex.slice(1)}`;
  },
  csvExport(clients: Client[]): string {
    const headers = ['Nombre', 'Teléfono', 'Marca', 'Categoría', 'Visitas', 'Meta', 'Premio entregado', 'Fecha alta'];
    const rows = clients.map(c => [
      c.name,
      c.phone || '',
      c.brand === 'rosa' ? 'Uñas' : 'Corporal & Facial',
      c.category || BRAND_TO_CATEGORY[c.brand],
      c.visits.length.toString(),
      c.goal.toString(),
      c.rewardClaimed ? 'Sí' : 'No',
      new Date(c.createdAt).toLocaleDateString('es-AR'),
    ]);
    return [headers, ...rows].map(r => r.map(v => `"${v}"`).join(',')).join('\n');
  },

  // ─── Card-share message (used together with the rendered image) ───
  // Returns a warm, elegant message tailored to the client's progress.
  // Used by the "Enviar tarjeta" flow that shares the image + this text.
  cardShareMessage(client: Client, businessName: string, rewardText: string, publicUrl?: string): string {
    const firstName = client.name.split(' ')[0];
    const completed = client.visits.length;
    const remaining = clientService.remainingVisits(client);
    const isComplete = clientService.isComplete(client);
    const linkLine = publicUrl ? `\n\nMirá tu tarjeta acá: ${publicUrl}` : '';

    if (isComplete && !client.rewardClaimed) {
      return `💖 ¡${firstName}! Tu tarjeta VIP en ${businessName} está completa ✨\nTe ganaste tu premio: ${rewardText} 🎁${linkLine}`;
    }
    if (isComplete && client.rewardClaimed) {
      return `💖 Así va tu tarjeta VIP en ${businessName} ${firstName} ✨\n¡Premio entregado! Gracias por ser parte 💖${linkLine}`;
    }
    if (remaining === 1) {
      return `💖 Así va tu tarjeta VIP actualizada en ${businessName} ✨\nLlevás ${completed} visitas y te falta solo 1 para tu premio 🎁${linkLine}`;
    }
    return `💖 Así va tu tarjeta VIP actualizada en ${businessName} ✨\nYa llevás ${completed} visitas y estás cada vez más cerca de tu premio 🎁${linkLine}`;
  },

  // ─── Capability detection — can this device share files natively? ───
  canShareFiles(): boolean {
    try {
      if (typeof navigator === 'undefined' || !navigator.share || !navigator.canShare) return false;
      // Probe with a dummy 1-byte file
      const probe = new File(['x'], 'probe.png', { type: 'image/png' });
      return navigator.canShare({ files: [probe] });
    } catch {
      return false;
    }
  },
};

// ─── cardRenderService — turn the card DOM node into a PNG blob ───
// Uses html2canvas under the hood, lazy-loaded so it doesn't bloat the
// initial bundle. Returns a Blob ready to share or download.
//
const cardRenderService = {
  async renderToBlob(cardNode: HTMLElement, scale = 3): Promise<Blob | null> {
    try {
      const html2canvas = (await import('https://esm.sh/html2canvas-pro@1.5.8' as any)).default;
      const canvas = await html2canvas(cardNode, {
        backgroundColor: null,
        scale,
        useCORS: true,
      });
      return await new Promise<Blob | null>((resolve) => {
        canvas.toBlob((b: Blob | null) => resolve(b), 'image/png');
      });
    } catch (err) {
      console.error('cardRenderService.renderToBlob', err);
      return null;
    }
  },

  // ─── Share strategies, in priority order ───

  // Strategy A: Native share with file attached (iOS/Android share sheet).
  // The user picks WhatsApp from the OS share sheet and the image + text
  // arrive pre-loaded in the chat.
  async shareNativeWithFile(blob: Blob, fileName: string, text: string): Promise<boolean> {
    try {
      if (!shareService.canShareFiles()) return false;
      const file = new File([blob], fileName, { type: 'image/png' });
      await navigator.share({ files: [file], text });
      return true;
    } catch (err: any) {
      // User cancelled → treat as success (no fallback)
      if (err?.name === 'AbortError') return true;
      console.warn('shareNativeWithFile failed, will fall back', err);
      return false;
    }
  },

  // Strategy B: Native share with text only (no file). Used on devices that
  // support navigator.share but not file sharing.
  async shareNativeTextOnly(text: string): Promise<boolean> {
    try {
      if (typeof navigator === 'undefined' || !navigator.share) return false;
      await navigator.share({ text });
      return true;
    } catch (err: any) {
      if (err?.name === 'AbortError') return true;
      return false;
    }
  },

  // Strategy C: Download the image + open WhatsApp Web with the text.
  // The user has to attach the just-downloaded image manually.
  downloadAndOpenWhatsapp(blob: Blob, fileName: string, text: string, phone?: string): void {
    // Trigger download
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 5_000);

    // Open WhatsApp with the message
    const cleanPhone = (phone || '').replace(/\D/g, '');
    const waUrl = cleanPhone
      ? `https://wa.me/${cleanPhone}?text=${encodeURIComponent(text)}`
      : `https://wa.me/?text=${encodeURIComponent(text)}`;
    window.open(waUrl, '_blank');
  },
};

// ─── crmService — engagement & retention intelligence ───
// All pure functions. Given clients + thresholds, compute states, alerts,
// rankings, and metrics. No React, no DOM. Easy to reuse from a backend
// or the future parent admin app.
//
const crmService = {
  // ─── Days helpers ───
  daysSince(iso: string | undefined | null): number | null {
    if (!iso) return null;
    const ms = Date.now() - new Date(iso).getTime();
    return Math.floor(ms / (1000 * 60 * 60 * 24));
  },

  lastVisitISO(client: Client): string | null {
    if (client.visits.length === 0) return null;
    return client.visits[client.visits.length - 1].date;
  },

  daysSinceLastVisit(client: Client): number | null {
    return crmService.daysSince(crmService.lastVisitISO(client));
  },

  visitsInLastNDays(client: Client, n: number): number {
    const cutoff = Date.now() - n * 24 * 60 * 60 * 1000;
    return client.visits.filter(v => new Date(v.date).getTime() >= cutoff).length;
  },

  rewardsCompleted(client: Client): number {
    // A reward is "completed" when visits hit the goal. Currently we track
    // one cycle per client (the rewardClaimed flag). Counting completed
    // rewards = 1 if the card is full, 0 otherwise. Future: cycle history.
    return clientService.isComplete(client) ? 1 : 0;
  },

  // ─── State classification ───
  // Priority order matters: a client is checked against states top-down.
  classify(client: Client, thresholds: CRMThresholds): ClientState {
    const visits = client.visits.length;
    const remaining = clientService.remainingVisits(client);
    const daysSince = crmService.daysSinceLastVisit(client);
    const isComplete = clientService.isComplete(client);

    // No visits yet
    if (visits === 0) return 'new';

    // Days-based states (apply regardless of progress)
    if (daysSince !== null && daysSince >= thresholds.dormantDays) return 'dormant';
    if (daysSince !== null && daysSince >= thresholds.inactiveDays) return 'inactive';

    // Already earned a reward and still active
    if (isComplete) return 'vip_top';

    // Near-reward signal (1 or 2 visits left)
    if (remaining > 0 && remaining <= thresholds.nearRewardRemaining) return 'near_reward';

    // Frequent: 3+ visits in last 60 days
    if (crmService.visitsInLastNDays(client, 60) >= thresholds.frequentVisitsIn60d) return 'frequent';

    // Created recently with at least one visit but nothing special
    if (visits <= 2 && daysSince !== null && daysSince <= 14) return 'new';

    return 'active';
  },

  // ─── Alert generator ───
  // Only states that need operator attention produce alerts.
  // Active / VIP top / Frequent are positive signals (shown but low priority).
  buildAlert(client: Client, businessName: string, rewardText: string, thresholds: CRMThresholds): CRMAlert | null {
    const state = crmService.classify(client, thresholds);
    const daysSince = crmService.daysSinceLastVisit(client);
    const remaining = clientService.remainingVisits(client);
    const firstName = client.name.split(' ')[0];

    // States we surface as alerts (in priority order)
    switch (state) {
      case 'near_reward':
        return {
          clientId: client.id,
          state,
          priority: 1,
          daysSinceLastVisit: daysSince,
          visitsRemaining: remaining,
          reason: remaining === 1
            ? '¡Le falta 1 visita para el premio!'
            : `Le faltan ${remaining} visitas para el premio`,
          whatsappTemplate: remaining === 1
            ? `✨ Hola ${firstName}! Te falta solo 1 visita para desbloquear tu premio en ${businessName}: ${rewardText} 💖 ¿Coordinamos un turno?`
            : `✨ Hola ${firstName}! Estás muy cerca de tu premio en ${businessName}: te faltan solo ${remaining} visitas para ${rewardText} 💖`,
        };

      case 'dormant':
        return {
          clientId: client.id,
          state,
          priority: 1,
          daysSinceLastVisit: daysSince,
          visitsRemaining: remaining,
          reason: `Hace ${daysSince} días que no viene · recuperación urgente`,
          whatsappTemplate: `✨ ¡Hola ${firstName}! Te extrañamos en ${businessName} 💖 Hace tiempo que no nos vemos, te queremos invitar con un beneficio especial para volver a vernos. ¿Coordinamos?`,
        };

      case 'inactive':
        return {
          clientId: client.id,
          state,
          priority: 2,
          daysSinceLastVisit: daysSince,
          visitsRemaining: remaining,
          reason: `Hace ${daysSince} días que no viene`,
          whatsappTemplate: `✨ Hola ${firstName}! Hace un tiempo que no te vemos en ${businessName} 💖 ¿Querés coordinar un turno? Tu tarjeta VIP te está esperando.`,
        };

      case 'vip_top':
        return {
          clientId: client.id,
          state,
          priority: 3,
          daysSinceLastVisit: daysSince,
          visitsRemaining: remaining,
          reason: 'Cliente VIP top · entregar premio o renovar',
          whatsappTemplate: `✨ ¡${firstName}, gracias por ser VIP top de ${businessName}! 💖 Tu premio te está esperando: ${rewardText}. Avisame cuándo querés disfrutarlo.`,
        };

      case 'frequent':
        return {
          clientId: client.id,
          state,
          priority: 3,
          daysSinceLastVisit: daysSince,
          visitsRemaining: remaining,
          reason: 'Clienta frecuente · reforzar vínculo',
          whatsappTemplate: `✨ Hola ${firstName}! Sos una de nuestras clientas más fieles en ${businessName} 💖 Gracias por confiar en nosotras siempre.`,
        };

      // 'active' and 'new' don't generate alerts
      default:
        return null;
    }
  },

  buildAllAlerts(clients: Client[], settings: Settings): CRMAlert[] {
    const thresholds = settings.crmThresholds || DEFAULT_CRM_THRESHOLDS;
    const alerts: CRMAlert[] = [];
    for (const c of clients) {
      const cfg = settings[c.brand];
      const alert = crmService.buildAlert(c, cfg.businessName, cfg.rewardText, thresholds);
      if (alert) alerts.push(alert);
    }
    // Sort by priority (1 first), then by daysSinceLastVisit desc within same priority
    alerts.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      const aDays = a.daysSinceLastVisit ?? 0;
      const bDays = b.daysSinceLastVisit ?? 0;
      return bDays - aDays;
    });
    return alerts;
  },

  // ─── Rankings ───
  topByVisits(clients: Client[], limit = 5): Client[] {
    return [...clients]
      .sort((a, b) => b.visits.length - a.visits.length)
      .slice(0, limit);
  },

  topByRewards(clients: Client[], limit = 5): Client[] {
    return [...clients]
      .filter(c => clientService.isComplete(c))
      .sort((a, b) => b.visits.length - a.visits.length)
      .slice(0, limit);
  },

  // ─── Aggregate metrics ───
  metrics(clients: Client[], thresholds: CRMThresholds) {
    const total = clients.length;
    if (total === 0) {
      return {
        total: 0,
        completionRate: 0,
        retentionRate: 0,
        avgVisitsPerClient: 0,
        rewardsDelivered: 0,
        activeThisMonth: 0,
        byState: { new: 0, active: 0, frequent: 0, near_reward: 0, inactive: 0, dormant: 0, vip_top: 0 } as Record<ClientState, number>,
        monthlyActivity: [] as { label: string; count: number }[],
      };
    }
    const byState: Record<ClientState, number> = { new: 0, active: 0, frequent: 0, near_reward: 0, inactive: 0, dormant: 0, vip_top: 0 };
    let totalVisits = 0;
    let rewardsDelivered = 0;
    let activeThisMonth = 0;
    const cutoff30 = Date.now() - 30 * 24 * 60 * 60 * 1000;

    for (const c of clients) {
      byState[crmService.classify(c, thresholds)]++;
      totalVisits += c.visits.length;
      if (c.rewardClaimed) rewardsDelivered++;
      if (c.visits.some(v => new Date(v.date).getTime() >= cutoff30)) activeThisMonth++;
    }

    const completionRate = total > 0 ? (clients.filter(c => clientService.isComplete(c)).length / total) * 100 : 0;
    const retentionRate = total > 0 ? (activeThisMonth / total) * 100 : 0;

    // Monthly activity over the last 6 months
    const monthlyActivity: { label: string; count: number }[] = [];
    const monthLabels = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
    const now = new Date();
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const dEnd = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
      const startMs = d.getTime();
      const endMs = dEnd.getTime();
      let count = 0;
      for (const c of clients) {
        for (const v of c.visits) {
          const t = new Date(v.date).getTime();
          if (t >= startMs && t < endMs) count++;
        }
      }
      monthlyActivity.push({ label: monthLabels[d.getMonth()], count });
    }

    return {
      total,
      completionRate,
      retentionRate,
      avgVisitsPerClient: totalVisits / total,
      rewardsDelivered,
      activeThisMonth,
      byState,
      monthlyActivity,
    };
  },

  // ─── State display helpers (UI uses these for labels/colors) ───
  stateMeta: {
    new:         { label: 'Nueva',         emoji: '🆕', color: '#94A3B8', tint: '#E2E8F0' },
    active:      { label: 'Activa',        emoji: '✨', color: '#8FA378', tint: '#E5E8DA' },
    frequent:    { label: 'Frecuente',     emoji: '💚', color: '#5C8A4A', tint: '#D9E5C8' },
    near_reward: { label: 'Cerca premio',  emoji: '🎁', color: '#D4AF7F', tint: '#F4DDB0' },
    inactive:    { label: 'Inactiva',      emoji: '😴', color: '#D69A4E', tint: '#F8E0BC' },
    dormant:     { label: 'Dormida',       emoji: '🚨', color: '#C14B5C', tint: '#F4D0D5' },
    vip_top:     { label: 'VIP Top',       emoji: '⭐', color: '#A876C9', tint: '#E8D5F2' },
  } as Record<ClientState, { label: string; emoji: string; color: string; tint: string }>,
};

// ─── imageService — resize & compress uploaded images ───
// Browsers store every uploaded image as base64 in localStorage. A 2000x2000
// JPEG that's only displayed at 14x14 in the card wastes ~250KB per image
// and slows the whole app. This service downsizes to a sane resolution
// before saving, preserves transparency for PNGs, and keeps file size small.
//
const imageService = {
  // Resize an image File to fit within maxSize x maxSize, keeping aspect ratio.
  // Returns a base64 data URL (PNG to preserve transparency).
  async processFile(file: File, maxSize = 256, quality = 0.92): Promise<string> {
    // Read file as data URL first
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(new Error('No se pudo leer el archivo'));
      reader.readAsDataURL(file);
    });
    return imageService.processDataUrl(dataUrl, maxSize, quality);
  },

  async processDataUrl(dataUrl: string, maxSize = 256, quality = 0.92): Promise<string> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        try {
          // Compute new dimensions keeping aspect ratio
          let { width, height } = img;
          if (width > maxSize || height > maxSize) {
            if (width > height) {
              height = Math.round((height / width) * maxSize);
              width = maxSize;
            } else {
              width = Math.round((width / height) * maxSize);
              height = maxSize;
            }
          }
          // Draw onto canvas
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          if (!ctx) {
            // Fallback: return original
            resolve(dataUrl);
            return;
          }
          // Enable smoothing for better quality
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'high';
          ctx.drawImage(img, 0, 0, width, height);
          // PNG preserves transparency. For photos (JPEGs), we'd save bytes
          // by using JPEG, but logos benefit more from PNG.
          // We try PNG first; if it's huge, fall back to JPEG.
          const png = canvas.toDataURL('image/png');
          if (png.length < 200_000) {
            resolve(png);
            return;
          }
          // Photo-like content: use JPEG with white background
          const ctx2 = canvas.getContext('2d');
          if (ctx2) {
            ctx2.globalCompositeOperation = 'destination-over';
            ctx2.fillStyle = '#ffffff';
            ctx2.fillRect(0, 0, width, height);
          }
          resolve(canvas.toDataURL('image/jpeg', quality));
        } catch (err) {
          reject(err);
        }
      };
      img.onerror = () => reject(new Error('No se pudo procesar la imagen'));
      img.src = dataUrl;
    });
  },
};

// ─── themeService — gradient/theme builder ───
const themeService = {
  lighten(hex: string, amount = 30): string {
    const h = hex.replace('#', '');
    const r = Math.min(255, Math.max(0, parseInt(h.slice(0, 2), 16) + amount));
    const g = Math.min(255, Math.max(0, parseInt(h.slice(2, 4), 16) + amount));
    const b = Math.min(255, Math.max(0, parseInt(h.slice(4, 6), 16) + amount));
    return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
  },
  build(cfg: BrandConfig, brand: Brand) {
    const accentLight = themeService.lighten(cfg.accent, 40);
    const accentDark = themeService.lighten(cfg.accent, -40);
    const primaryLight = themeService.lighten(cfg.primary, 25);
    return {
      name: brand === 'rosa' ? `${cfg.businessName} • Uñas` : `${cfg.businessName} • Corporal & Facial`,
      primary: cfg.primary,
      primaryDark: cfg.primaryDark,
      accent: cfg.accent,
      bg: cfg.bg,
      bgCard: themeService.lighten(cfg.primary, 10),
      text: cfg.textTone,
      gradient: `linear-gradient(135deg, ${primaryLight} 0%, ${cfg.primary} 50%, ${cfg.primaryDark} 100%)`,
      gradientPremium: `linear-gradient(135deg, ${themeService.lighten(cfg.bg, 5)} 0%, ${primaryLight} 40%, ${cfg.primary} 100%)`,
      foil: `linear-gradient(135deg, ${cfg.accent} 0%, ${accentLight} 25%, ${accentDark} 50%, ${accentLight} 75%, ${cfg.accent} 100%)`,
      icon: brand === 'rosa' ? '🌸' : '🌿',
    };
  },
  buildAll(settings: Settings) {
    return {
      rosa: themeService.build(settings.rosa, 'rosa'),
      verde: themeService.build(settings.verde, 'verde'),
    };
  },
};

// ═══════════════════════════════════════════════════════════════════
// 5. PUBLIC API — VIPModule namespace
// ═══════════════════════════════════════════════════════════════════
// THIS is what the parent admin app imports & uses.
// Everything else is internal.
//
// Example usage from parent app:
//   const api = VIPModule.createAPI(myFirebaseAdapter);
//   await api.addClient({ name: 'María', brand: 'rosa', ... });
//   const clients = await api.getClients();
//   const stats = api.getStats(clients);
//
// This API is decoupled from React entirely — it's safe to call from
// a backend, a CLI, a CRM webhook, or another app.
//
const VIPModule = {
  // Re-export pure services
  clientService,
  visitService,
  settingsService,
  statsService,
  shareService,
  themeService,
  crmService,

  // Re-export adapters
  LocalStorageAdapter,

  // High-level API factory — takes an adapter, returns a CRM-friendly API
  createAPI(adapter: StorageAdapter = new LocalStorageAdapter(), events: VIPEvents = {}) {
    return {
      // ─── Clients ───
      async getClients(): Promise<Client[]> {
        return adapter.loadClients();
      },
      async getClient(id: string): Promise<Client | null> {
        const all = await adapter.loadClients();
        return all.find(c => c.id === id) || null;
      },
      async addClient(input: Omit<Client, 'id' | 'visits' | 'rewardClaimed' | 'createdAt'>): Promise<Client> {
        const all = await adapter.loadClients();
        const newClient = clientService.create(input);
        await adapter.saveClients([newClient, ...all]);
        events.onClientCreated?.(newClient);
        return newClient;
      },
      async updateClient(id: string, patch: Partial<Client>): Promise<Client | null> {
        const all = await adapter.loadClients();
        const idx = all.findIndex(c => c.id === id);
        if (idx === -1) return null;
        const updated = clientService.update(all[idx], patch);
        all[idx] = updated;
        await adapter.saveClients(all);
        events.onClientUpdated?.(updated);
        return updated;
      },
      async deleteClient(id: string): Promise<boolean> {
        const all = await adapter.loadClients();
        const next = all.filter(c => c.id !== id);
        if (next.length === all.length) return false;
        await adapter.saveClients(next);
        events.onClientDeleted?.(id);
        return true;
      },
      // ─── Visits ───
      async addVisit(clientId: string, options?: { appointmentId?: string; note?: string; stamp?: VisitStamp }): Promise<Client | null> {
        const all = await adapter.loadClients();
        const idx = all.findIndex(c => c.id === clientId);
        if (idx === -1) return null;
        const wasComplete = clientService.isComplete(all[idx]);
        const updated = visitService.add(all[idx], options);
        all[idx] = updated;
        await adapter.saveClients(all);
        const newVisit = updated.visits[updated.visits.length - 1];
        if (newVisit) events.onVisitAdded?.(updated, newVisit);
        if (!wasComplete && clientService.isComplete(updated)) {
          events.onRewardCompleted?.(updated);
        }
        return updated;
      },
      async removeLastVisit(clientId: string): Promise<Client | null> {
        const all = await adapter.loadClients();
        const idx = all.findIndex(c => c.id === clientId);
        if (idx === -1) return null;
        const updated = visitService.removeLast(all[idx]);
        all[idx] = updated;
        await adapter.saveClients(all);
        events.onVisitRemoved?.(updated);
        return updated;
      },
      async toggleReward(clientId: string): Promise<Client | null> {
        const all = await adapter.loadClients();
        const idx = all.findIndex(c => c.id === clientId);
        if (idx === -1) return null;
        const updated = visitService.toggleRewardClaimed(all[idx]);
        all[idx] = updated;
        await adapter.saveClients(all);
        if (updated.rewardClaimed) events.onRewardClaimed?.(updated);
        return updated;
      },
      // ─── Stats & queries ───
      getStats: statsService.compute,
      filter: statsService.filter,
      // ─── Share ───
      buildShareMessage: shareService.whatsappMessage,
      buildQRUrl: shareService.qrUrl,
      exportCSV: shareService.csvExport,
      // ─── CRM ───
      classifyClient: (c: Client, thresholds?: CRMThresholds) =>
        crmService.classify(c, thresholds || DEFAULT_CRM_THRESHOLDS),
      buildAlerts: crmService.buildAllAlerts,
      crmMetrics: (clients: Client[], thresholds?: CRMThresholds) =>
        crmService.metrics(clients, thresholds || DEFAULT_CRM_THRESHOLDS),
      topByVisits: crmService.topByVisits,
      topByRewards: crmService.topByRewards,
    };
  },
};

// Expose the API to the global window so the parent app (or DevTools) can probe it.
// In a multi-file project, replace this with a proper named export.
if (typeof window !== 'undefined') {
  (window as any).GinailsVIP = VIPModule;
}

// ═══════════════════════════════════════════════════════════════════
// 6. HELPERS — Display formatting (used only by UI)
// ═══════════════════════════════════════════════════════════════════
const formatStampDate = (iso: string) => {
  const d = new Date(iso);
  const months = ['ENE', 'FEB', 'MAR', 'ABR', 'MAY', 'JUN', 'JUL', 'AGO', 'SEP', 'OCT', 'NOV', 'DIC'];
  return `${d.getDate()} ${months[d.getMonth()]}`;
};

const formatDateLong = (iso: string) => {
  return new Date(iso).toLocaleDateString('es-AR', { day: 'numeric', month: 'long', year: 'numeric' });
};

// ═══════════════════════════════════════════════════════════════════
// 7. HOOK — useVIPModule: the single integration point for the UI
// ═══════════════════════════════════════════════════════════════════
// The UI never reads/writes state directly. It calls this hook and gets
// back state + actions. To swap LocalStorage for Firebase later, you only
// change the adapter passed in here.
//
// All actions here go through the services above, so business rules
// stay in one place.
//
function useVIPModule(config?: VIPModuleConfig) {
  const adapter = useMemo(() => config?.storageAdapter ?? new LocalStorageAdapter(), [config?.storageAdapter]);
  const events = config?.events;
  const readOnly = !!config?.readOnly;

  const [clients, setClients] = useState<Client[]>(config?.initialClients ?? []);
  const [settings, setSettings] = useState<Settings>(settingsService.defaults());
  const [loaded, setLoaded] = useState(false);

  // Memoized themes built from current settings
  const themes = useMemo(() => themeService.buildAll(settings), [settings]);

  // ── Load on mount ──
  useEffect(() => {
    let alive = true;
    (async () => {
      const [loadedClients, loadedSettings] = await Promise.all([
        adapter.loadClients(),
        adapter.loadSettings(),
      ]);
      if (!alive) return;
      if (config?.initialClients?.length) {
        setClients(config.initialClients);
      } else if (loadedClients.length) {
        setClients(loadedClients);
      }
      setSettings(settingsService.migrate(loadedSettings));
      setLoaded(true);
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adapter]);

  // ── Persist when state changes ──
  useEffect(() => {
    if (!loaded || readOnly) return;
    adapter.saveClients(clients);
  }, [clients, loaded, readOnly, adapter]);

  useEffect(() => {
    if (!loaded || readOnly) return;
    adapter.saveSettings(settings);
  }, [settings, loaded, readOnly, adapter]);

  // ── Actions ── (all go through services, all emit events)
  const actions = useMemo(() => ({
    saveClient: (data: Omit<Client, 'id' | 'visits' | 'rewardClaimed' | 'createdAt'> & { id?: string }) => {
      if (readOnly) return;
      if (data.id) {
        setClients(prev => prev.map(c => {
          if (c.id !== data.id) return c;
          const updated = clientService.update(c, data as Partial<Client>);
          events?.onClientUpdated?.(updated);
          return updated;
        }));
      } else {
        const newClient = clientService.create({
          ...data,
          tenantId: config?.tenantId,
        });
        setClients(prev => [newClient, ...prev]);
        events?.onClientCreated?.(newClient);
      }
    },
    deleteClient: (id: string) => {
      if (readOnly) return;
      setClients(prev => prev.filter(c => c.id !== id));
      events?.onClientDeleted?.(id);
    },
    addVisit: (clientId: string, options?: { appointmentId?: string; note?: string; stamp?: VisitStamp; date?: string }) => {
      if (readOnly) return;
      setClients(prev => prev.map(c => {
        if (c.id !== clientId) return c;
        const wasComplete = clientService.isComplete(c);
        const updated = visitService.add(c, options);
        const newVisit = updated.visits[updated.visits.length - 1];
        if (newVisit && updated.visits.length !== c.visits.length) {
          events?.onVisitAdded?.(updated, newVisit);
        }
        if (!wasComplete && clientService.isComplete(updated)) {
          events?.onRewardCompleted?.(updated);
        }
        return updated;
      }));
    },
    removeLastVisit: (clientId: string) => {
      if (readOnly) return;
      setClients(prev => prev.map(c => {
        if (c.id !== clientId) return c;
        const updated = visitService.removeLast(c);
        events?.onVisitRemoved?.(updated);
        return updated;
      }));
    },
    updateVisit: (clientId: string, index: number, patch: Partial<Visit>) => {
      if (readOnly) return;
      setClients(prev => prev.map(c => {
        if (c.id !== clientId) return c;
        return visitService.updateAt(c, index, patch);
      }));
    },
    removeVisitAt: (clientId: string, index: number) => {
      if (readOnly) return;
      setClients(prev => prev.map(c => {
        if (c.id !== clientId) return c;
        const updated = visitService.removeAt(c, index);
        events?.onVisitRemoved?.(updated);
        return updated;
      }));
    },
    toggleRewardClaimed: (clientId: string) => {
      if (readOnly) return;
      setClients(prev => prev.map(c => {
        if (c.id !== clientId) return c;
        const updated = visitService.toggleRewardClaimed(c);
        if (updated.rewardClaimed) events?.onRewardClaimed?.(updated);
        return updated;
      }));
    },
    updateSettings: (patch: Partial<Settings> | ((s: Settings) => Settings)) => {
      if (readOnly) return;
      setSettings(prev => typeof patch === 'function' ? patch(prev) : { ...prev, ...patch });
    },
    updateBrandConfig: (brand: Brand, patch: Partial<BrandConfig>) => {
      if (readOnly) return;
      setSettings(prev => ({ ...prev, [brand]: { ...prev[brand], ...patch } }));
    },
    resetBrandConfig: (brand: Brand) => {
      if (readOnly) return;
      setSettings(prev => ({ ...prev, [brand]: { ...DEFAULT_BRAND_CONFIG[brand] } }));
    },
    clearAllClients: () => {
      if (readOnly) return;
      setClients([]);
    },
  }), [readOnly, events, config?.tenantId]);

  // ── Backwards-compat alias kept for the existing UI code ──
  // (so the rest of the file keeps working without rewrites)
  const setSettingsCompat = (updater: any) => actions.updateSettings(updater);

  return {
    clients,
    settings,
    setSettings: setSettingsCompat,
    themes,
    loaded,
    readOnly,
    actions,
  };
}

// ═══════════════════════════════════════════════════════════════════
// 8. UI — Components below this line are presentational only
// ═══════════════════════════════════════════════════════════════════
// They consume `useVIPModule` and never touch storage or business logic
// directly. The visual experience remains exactly as the MVP shipped.

// ─── UI-only constants (icon glyphs, template metadata) ───
const STAMP_ICONS: Record<StampIcon, { rosa: string; verde: string; component: React.FC<any> }> = {
  heart: { rosa: '💗', verde: '💚', component: Heart },
  gem: { rosa: '💎', verde: '💎', component: Gem },
  star: { rosa: '⭐', verde: '✨', component: Star },
  flower: { rosa: '🌸', verde: '🌿', component: Flower2 },
  leaf: { rosa: '🍃', verde: '🌿', component: Leaf },
  droplet: { rosa: '💧', verde: '💧', component: Droplet },
  sparkle: { rosa: '✨', verde: '✨', component: Sparkles },
  crown: { rosa: '👑', verde: '👑', component: Crown },
};

const TEMPLATES: { id: Template; label: string; description: string }[] = [
  { id: 'elegante', label: 'Elegante', description: 'Clásico con foil dorado' },
  { id: 'minimalista', label: 'Minimalista', description: 'Líneas limpias, espacio puro' },
  { id: 'glam', label: 'Glam', description: 'Brillos y máximo lujo' },
  { id: 'neutra', label: 'Neutra', description: 'Tonos arena y equilibrio' },
  { id: 'moderna', label: 'Moderna', description: 'Geometría editorial' },
];

// ═══════════════════════════════════════════════════════════════════
// VIP CARD — the centerpiece
// ═══════════════════════════════════════════════════════════════════
const VIPCard: React.FC<{
  client: Client;
  businessName: string;
  rewardText: string;
  logo: string | null;
  theme: ReturnType<typeof themeService.build>;
  customStamps?: CustomStamp[];
  cardSubtitle?: string;
  cardRef?: React.RefObject<HTMLDivElement>;
}> = ({ client, businessName, rewardText, logo, theme, customStamps = [], cardSubtitle = '', cardRef }) => {
  const completed = client.visits.length;
  const isComplete = completed >= client.goal;
  const progress = Math.min(100, (completed / client.goal) * 100);
  // Default stamp (used as fallback when a visit has no per-visit stamp)
  const DefaultStampComp = STAMP_ICONS[client.stampIcon].component;

  // Template-specific styling
  const templateStyles: Record<Template, { container: string; cardBg: string; textTone: string }> = {
    elegante: {
      container: '',
      cardBg: theme.gradientPremium,
      textTone: theme.text,
    },
    minimalista: {
      container: '',
      cardBg: client.brand === 'rosa' ? '#FDF6F3' : '#F5F3EC',
      textTone: theme.text,
    },
    glam: {
      container: '',
      cardBg: `linear-gradient(135deg, ${theme.primary} 0%, ${theme.accent} 100%)`,
      textTone: '#fff',
    },
    neutra: {
      container: '',
      cardBg: client.brand === 'rosa' ? '#EFE0DC' : '#DDD9CC',
      textTone: theme.text,
    },
    moderna: {
      container: '',
      cardBg: client.brand === 'rosa' ? '#2A1F22' : '#1F2A1F',
      textTone: '#FCEFE8',
    },
  };

  const tStyle = templateStyles[client.template];
  const isDarkTemplate = client.template === 'moderna';

  return (
    <div
      ref={cardRef}
      className="relative w-full max-w-md mx-auto aspect-[1.586/1] rounded-3xl overflow-hidden shadow-2xl"
      style={{
        background: tStyle.cardBg,
        boxShadow: '0 30px 60px -20px rgba(0,0,0,0.25), 0 0 0 1px rgba(255,255,255,0.4) inset',
      }}
    >
      {/* Texture overlay */}
      <div className="absolute inset-0 opacity-30 mix-blend-overlay pointer-events-none"
        style={{
          backgroundImage: `radial-gradient(circle at 20% 30%, ${theme.accent}22 0%, transparent 40%), radial-gradient(circle at 80% 80%, ${theme.primary}33 0%, transparent 50%)`,
        }} />

      {/* Decorative corner ornaments for elegante */}
      {client.template === 'elegante' && (
        <>
          <div className="absolute top-3 right-3 w-12 h-12 opacity-60" style={{ background: theme.foil, WebkitMaskImage: 'radial-gradient(circle, transparent 30%, black 31%, black 60%, transparent 61%)', maskImage: 'radial-gradient(circle, transparent 30%, black 31%, black 60%, transparent 61%)' }} />
          <div className="absolute bottom-3 left-3 w-8 h-8 opacity-50 rotate-45" style={{ background: theme.foil }} />
        </>
      )}

      {/* Glam shimmer */}
      {client.template === 'glam' && (
        <div className="absolute inset-0 opacity-40 pointer-events-none"
          style={{ background: `linear-gradient(105deg, transparent 30%, rgba(255,255,255,0.6) 50%, transparent 70%)` }} />
      )}

      {/* Moderna geometric */}
      {client.template === 'moderna' && (
        <>
          <div className="absolute -top-8 -right-8 w-32 h-32 rounded-full" style={{ background: theme.foil, opacity: 0.15 }} />
          <div className="absolute bottom-0 left-0 w-full h-1" style={{ background: theme.foil }} />
        </>
      )}

      <div className="relative h-full p-5 sm:p-6 flex flex-col" style={{ color: tStyle.textTone }}>
        {/* Header */}
        <div className="flex items-start justify-between mb-2 gap-3">
          <div className="flex-1 min-w-0">
            <div className="text-[10px] tracking-[0.3em] uppercase opacity-70 font-medium">VIP Member</div>
            <div
              className="text-2xl sm:text-3xl leading-tight mt-0.5 truncate"
              style={{ fontFamily: '"Cormorant Garamond", serif', fontWeight: 600, fontStyle: 'italic' }}
            >
              {client.name}
            </div>
          </div>
          <div className="text-right flex flex-col items-end gap-1 flex-shrink-0">
            {logo ? (
              <div
                className="w-12 h-12 sm:w-14 sm:h-14 rounded-full overflow-hidden flex-shrink-0"
                style={{
                  border: `1.5px solid ${theme.accent}`,
                  background: '#fff',
                  boxShadow: `0 4px 12px ${theme.accent}33`,
                }}
              >
                <img src={logo} alt="logo" className="w-full h-full object-cover" />
              </div>
            ) : (
              <div
                className="text-base sm:text-lg leading-tight"
                style={{
                  fontFamily: '"Cormorant Garamond", serif',
                  fontWeight: 700,
                  background: theme.foil,
                  WebkitBackgroundClip: 'text',
                  backgroundClip: 'text',
                  color: 'transparent',
                }}
              >
                {businessName}
              </div>
            )}
            <div className="text-[9px] tracking-[0.2em] uppercase opacity-60">
              {cardSubtitle || ''}
            </div>
          </div>
        </div>

        {/* Stamps grid */}
        <div className="flex-1 flex items-center justify-center my-3">
          <div
            className={`grid gap-1.5 sm:gap-2 w-full ${
              client.goal <= 5 ? 'grid-cols-5' :
              client.goal <= 6 ? 'grid-cols-6' :
              client.goal <= 8 ? 'grid-cols-4' :
              client.goal <= 10 ? 'grid-cols-5' :
              'grid-cols-5'
            }`}
            style={{ maxWidth: client.goal <= 5 ? '100%' : '100%' }}
          >
            {Array.from({ length: client.goal }).map((_, i) => {
              const visit = client.visits[i];
              const isLast = i === client.goal - 1;
              // Resolve which stamp to render for THIS visit
              // Priority: per-visit stamp → client default → client.stampIcon
              const customStampMap = new Map(customStamps.map(s => [s.id, s]));
              let stampNode: React.ReactNode = null;
              if (visit) {
                const stampColor = isLast ? '#fff' : (isDarkTemplate ? '#fff' : theme.primaryDark);
                if (visit.stamp?.kind === 'custom') {
                  const cs = customStampMap.get(visit.stamp.id);
                  if (cs) {
                    stampNode = (
                      <img
                        src={cs.image}
                        alt={cs.label}
                        className="w-[80%] h-[80%] object-contain rounded-full"
                        style={{ filter: isLast ? 'brightness(0) invert(1)' : 'none' }}
                      />
                    );
                  }
                } else if (visit.stamp?.kind === 'emoji') {
                  stampNode = (
                    <span style={{ fontSize: '0.85em', lineHeight: 1 }}>{visit.stamp.char}</span>
                  );
                } else if (visit.stamp?.kind === 'icon') {
                  const Comp = STAMP_ICONS[visit.stamp.id].component;
                  stampNode = <Comp size={14} style={{ color: stampColor, fill: stampColor }} />;
                }
                // Fallback to default stamp icon for legacy visits without a stamp
                if (!stampNode) {
                  stampNode = <DefaultStampComp size={14} style={{ color: stampColor, fill: stampColor }} />;
                }
              }
              return (
                <div key={i} className="aspect-square flex items-center justify-center relative">
                  <div
                    className="w-full h-full rounded-full flex items-center justify-center relative transition-all overflow-hidden"
                    style={{
                      border: visit ? 'none' : `1.5px ${isLast ? 'dashed' : 'solid'} ${isDarkTemplate ? 'rgba(252,239,232,0.4)' : theme.accent + '88'}`,
                      background: visit
                        ? (isLast ? theme.foil : (isDarkTemplate ? theme.accent : theme.primary + '40'))
                        : 'transparent',
                      boxShadow: visit ? `0 4px 12px ${theme.accent}44` : 'none',
                    }}
                  >
                    {stampNode}
                    {!visit && isLast && (
                      <Gift size={12} style={{ color: theme.accent, opacity: 0.5 }} />
                    )}
                  </div>
                  {visit && (
                    <div
                      className="absolute -bottom-3.5 left-1/2 -translate-x-1/2 text-[7px] tracking-wider font-semibold whitespace-nowrap"
                      style={{ color: tStyle.textTone, opacity: 0.7 }}
                    >
                      {formatStampDate(visit.date)}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Footer */}
        <div className="mt-auto pt-2">
          {isComplete ? (
            <div className="text-center">
              <div
                className="text-sm sm:text-base"
                style={{
                  fontFamily: '"Cormorant Garamond", serif',
                  fontStyle: 'italic',
                  background: theme.foil,
                  WebkitBackgroundClip: 'text',
                  backgroundClip: 'text',
                  color: 'transparent',
                  fontWeight: 700,
                }}
              >
                ✦ Premio desbloqueado ✦
              </div>
              <div className="text-[10px] opacity-70 mt-0.5">{rewardText}</div>
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between text-[10px] mb-1.5 opacity-80">
                <span className="tracking-widest uppercase">Progreso</span>
                <span className="font-semibold">{completed} / {client.goal}</span>
              </div>
              <div className="h-1 rounded-full overflow-hidden" style={{ background: isDarkTemplate ? 'rgba(252,239,232,0.15)' : theme.accent + '22' }}>
                <div
                  className="h-full rounded-full transition-all duration-700"
                  style={{ width: `${progress}%`, background: theme.foil }}
                />
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

// ═══════════════════════════════════════════════════════════════════
// MAIN APP
// ═══════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════
// 9. ROOT COMPONENT — accepts an optional VIPModuleConfig prop
// ═══════════════════════════════════════════════════════════════════
// Standalone usage (today, in this artifact):
//   <GinailsVIP />
//
// Embedded usage (tomorrow, in your admin app):
//   <GinailsVIP config={{
//     storageAdapter: new FirebaseAdapter(...),
//     events: { onVisitAdded: (c, v) => crm.notify(c) },
//     lockedBrand: 'rosa',
//     tenantId: 'studio-cordoba-001',
//   }} />
//
// ═══════════════════════════════════════════════════════════════════
// LOGIN SCREEN — Google sign-in gate
// ═══════════════════════════════════════════════════════════════════
const LoginScreen: React.FC = () => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Inject Google Fonts for the login screen too
  useEffect(() => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,500;0,600;0,700;1,400;1,600;1,700&family=Outfit:wght@300;400;500;600;700&display=swap';
    document.head.appendChild(link);
    return () => { document.head.removeChild(link); };
  }, []);

  const handleLogin = async () => {
    setError(null);
    setLoading(true);
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (err: any) {
      console.error('Login error', err);
      setError(err?.message || 'No se pudo iniciar sesión');
      setLoading(false);
    }
  };

  return (
    <div
      className="min-h-screen w-full flex items-center justify-center p-6"
      style={{
        background: 'radial-gradient(ellipse at top, #FDF6F3 0%, #F5F0EC 50%, #EFEAE4 100%)',
        fontFamily: '"Outfit", system-ui, sans-serif',
      }}
    >
      <div className="fixed inset-0 pointer-events-none overflow-hidden" style={{ zIndex: 0 }}>
        <div className="absolute -top-40 -right-40 w-96 h-96 rounded-full opacity-30 blur-3xl"
          style={{ background: 'radial-gradient(circle, #E8B4C0 0%, transparent 70%)' }} />
        <div className="absolute -bottom-40 -left-40 w-96 h-96 rounded-full opacity-25 blur-3xl"
          style={{ background: 'radial-gradient(circle, #B8C9A8 0%, transparent 70%)' }} />
      </div>

      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6 }}
        className="relative z-10 w-full max-w-md text-center"
      >
        <div className="mb-8">
          <div
            className="text-5xl sm:text-6xl leading-none mb-2"
            style={{
              fontFamily: '"Cormorant Garamond", serif',
              fontStyle: 'italic',
              fontWeight: 700,
              background: 'linear-gradient(135deg, #D4AF7F 0%, #C98AA0 50%, #8FA378 100%)',
              WebkitBackgroundClip: 'text',
              backgroundClip: 'text',
              color: 'transparent',
            }}
          >
            Ginails VIP
          </div>
          <div className="text-[11px] tracking-[0.35em] uppercase opacity-60">
            Loyalty · Premium
          </div>
        </div>

        <div
          className="rounded-3xl p-8 mb-4"
          style={{
            background: 'rgba(255,255,255,0.75)',
            backdropFilter: 'blur(20px)',
            border: '1px solid rgba(212,175,127,0.25)',
            boxShadow: '0 20px 60px rgba(201,138,160,0.15)',
          }}
        >
          <p className="text-sm opacity-75 mb-6 leading-relaxed">
            Ingresá con tu cuenta de Google para empezar a fidelizar a tus clientas
            con tarjetas digitales premium.
          </p>

          <button
            onClick={handleLogin}
            disabled={loading}
            className="w-full py-3.5 rounded-2xl font-medium tracking-wide flex items-center justify-center gap-3 transition-all hover:scale-[1.02] active:scale-95 disabled:opacity-60 disabled:cursor-not-allowed"
            style={{
              background: 'linear-gradient(135deg, #D4AF7F 0%, #C98AA0 100%)',
              color: '#fff',
              boxShadow: '0 10px 30px rgba(201,138,160,0.4)',
            }}
          >
            {loading ? (
              'Conectando…'
            ) : (
              <>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                  <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#fff"/>
                  <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#fff" opacity="0.9"/>
                  <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#fff" opacity="0.8"/>
                  <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#fff" opacity="0.95"/>
                </svg>
                Ingresar con Google
              </>
            )}
          </button>

          {error && (
            <p className="text-xs mt-3" style={{ color: '#c14' }}>
              {error}
            </p>
          )}
        </div>

        <p className="text-[10px] tracking-widest uppercase opacity-50">
          Tus datos se sincronizan en todos tus dispositivos
        </p>
      </motion.div>
    </div>
  );
};

function GinailsVIPApp({ config }: { config?: VIPModuleConfig } = {}) {
  // ─── State from the modular hook (single integration point) ───
  const { clients, settings, setSettings, themes, actions } = useVIPModule(config);

  // ─── Local UI-only state (view, modals, search) — not business state ───
  const [view, setView] = useState<'dashboard' | 'detail' | 'settings' | 'stats' | 'crm'>('dashboard');
  const [activeClientId, setActiveClientId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [filterBrand, setFilterBrand] = useState<'all' | Brand>('all');
  const [filterStatus, setFilterStatus] = useState<'all' | 'active' | 'complete'>('all');
  const [showAddModal, setShowAddModal] = useState(false);
  const [showShareModal, setShowShareModal] = useState(false);
  const [showQRModal, setShowQRModal] = useState(false);
  const [showStampPicker, setShowStampPicker] = useState(false);
  const [stampPickerMode, setStampPickerMode] = useState<'now' | 'backdated'>('now');
  const [editingVisitIndex, setEditingVisitIndex] = useState<number | null>(null);
  const [editingClient, setEditingClient] = useState<Client | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  // ─── Inject Google Fonts once ───
  useEffect(() => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,500;0,600;0,700;1,400;1,600;1,700&family=Outfit:wght@300;400;500;600;700&display=swap';
    document.head.appendChild(link);
    return () => { document.head.removeChild(link); };
  }, []);

  const dark = settings.darkMode;

  // ─── Derived state via services ───
  const filteredClients = useMemo(
    () => statsService.filter(clients, { search, brand: filterBrand, status: filterStatus }),
    [clients, search, filterBrand, filterStatus]
  );

  const activeClient = clients.find(c => c.id === activeClientId) || null;

  const stats = useMemo(() => statsService.compute(clients), [clients]);

  // CRM derived state
  const crmThresholds = settings.crmThresholds || DEFAULT_CRM_THRESHOLDS;
  const crmAlerts = useMemo(() => crmService.buildAllAlerts(clients, settings), [clients, settings]);
  const crmMetrics = useMemo(() => crmService.metrics(clients, crmThresholds), [clients, crmThresholds]);
  const topByVisits = useMemo(() => crmService.topByVisits(clients, 5), [clients]);

  // ─── Thin wrappers preserving the existing UI's expected APIs ───
  // The UI below was written against these names; we keep them stable
  // so the entire visual layer remains untouched.
  const saveClient = actions.saveClient;

  // Reliable replacement for window.confirm() — opens our visual dialog.
  // Caller passes a config; the dialog is rendered globally near the modals.
  const [confirmConfig, setConfirmConfig] = useState<{
    title: string;
    message?: string;
    confirmLabel?: string;
    danger?: boolean;
    onConfirm: () => void;
  } | null>(null);

  const askConfirm = (config: NonNullable<typeof confirmConfig>) => setConfirmConfig(config);

  const deleteClient = (id: string) => {
    askConfirm({
      title: '¿Eliminar clienta?',
      message: 'Se eliminará junto con todas sus visitas. Esta acción no se puede deshacer.',
      confirmLabel: 'Sí, eliminar',
      danger: true,
      onConfirm: () => {
        actions.deleteClient(id);
        if (activeClientId === id) {
          setActiveClientId(null);
          setView('dashboard');
        }
      },
    });
  };

  const addVisit = (clientId: string, stamp?: VisitStamp, date?: string) =>
    actions.addVisit(clientId, (stamp || date) ? { stamp, date } : undefined);
  const removeLastVisit = (clientId: string) => actions.removeLastVisit(clientId);
  const updateVisit = (clientId: string, index: number, patch: Partial<Visit>) =>
    actions.updateVisit(clientId, index, patch);
  const removeVisitAt = (clientId: string, index: number) =>
    actions.removeVisitAt(clientId, index);
  const toggleRewardClaimed = (clientId: string) => actions.toggleRewardClaimed(clientId);

  // ─── CSV export via shareService ───
  const exportCSV = () => {
    const csv = shareService.csvExport(clients);
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ginails-clientas-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // ─── Share card flow: render → try native share → fallback to download+WA ───
  // Mobile-first: on iOS/Android the OS share sheet lets the user pick WhatsApp
  // and the image arrives pre-attached in the chat. On desktop, the image
  // downloads and WhatsApp Web opens with the message ready to send.
  const [sharingCard, setSharingCard] = useState(false);

  const shareCard = async () => {
    if (!cardRef.current || !activeClient || sharingCard) return;
    setSharingCard(true);
    try {
      const cfg = settings[activeClient.brand];
      const publicUrl = `https://ginails-vip.pages.dev/c/${activeClient.id}`;
      const message = shareService.cardShareMessage(activeClient, cfg.businessName, cfg.rewardText, publicUrl);
      const fileName = `${activeClient.name.replace(/\s+/g, '-').toLowerCase()}-tarjeta-vip.png`;

      // Render the card to a PNG blob
      const blob = await cardRenderService.renderToBlob(cardRef.current);
      if (!blob) {
        alert('No se pudo generar la imagen. Probá de nuevo.');
        return;
      }

      // Strategy A: native share with file (best on mobile)
      if (shareService.canShareFiles()) {
        const ok = await cardRenderService.shareNativeWithFile(blob, fileName, message);
        if (ok) return;
      }

      // Strategy B (fallback for desktop / unsupported browsers):
      // download the image AND open WhatsApp Web with the message pre-loaded
      cardRenderService.downloadAndOpenWhatsapp(blob, fileName, message, activeClient.phone);
    } catch (err) {
      console.error('shareCard error', err);
      alert('Hubo un problema al compartir la tarjeta. Probá de nuevo.');
    } finally {
      setSharingCard(false);
    }
  };

  // ─── WhatsApp share via shareService ───
  const shareWhatsApp = () => {
    if (!activeClient) return;
    const cfg = settings[activeClient.brand];
    const msg = shareService.whatsappMessage(activeClient, cfg.businessName, cfg.rewardText);
    const url = shareService.whatsappUrl(activeClient, msg);
    window.open(url, '_blank');
  };

  // ─── QR via shareService ───
  const qrUrl = activeClient
    ? shareService.qrUrl(activeClient, themes[activeClient.brand].primaryDark, themes[activeClient.brand].bg)
    : '';

  // ═══════════════════════════════════════════════════════════════════
  // RENDER — UI is purely presentational from here on
  // ═══════════════════════════════════════════════════════════════════
  return (
    <div
      className="min-h-screen w-full transition-colors duration-500"
      style={{
        background: dark
          ? 'radial-gradient(ellipse at top, #2A1F2A 0%, #1A1217 100%)'
          : 'radial-gradient(ellipse at top, #FDF6F3 0%, #F5F0EC 50%, #EFEAE4 100%)',
        fontFamily: '"Outfit", system-ui, sans-serif',
        color: dark ? '#F0E5E0' : '#3D2A2E',
      }}
    >
      {/* Decorative atmosphere */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden" style={{ zIndex: 0 }}>
        <div className="absolute -top-40 -right-40 w-96 h-96 rounded-full opacity-30 blur-3xl"
          style={{ background: 'radial-gradient(circle, #E8B4C0 0%, transparent 70%)' }} />
        <div className="absolute -bottom-40 -left-40 w-96 h-96 rounded-full opacity-25 blur-3xl"
          style={{ background: 'radial-gradient(circle, #B8C9A8 0%, transparent 70%)' }} />
      </div>

      {/* HEADER */}
      <header className="relative z-10 backdrop-blur-xl border-b" style={{
        background: dark ? 'rgba(26,18,23,0.7)' : 'rgba(253,246,243,0.7)',
        borderColor: dark ? 'rgba(232,180,192,0.15)' : 'rgba(212,175,127,0.2)',
      }}>
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            {view !== 'dashboard' && (
              <button
                onClick={() => { setView('dashboard'); setActiveClientId(null); }}
                className="p-2 rounded-full transition-all hover:scale-110"
                style={{ background: dark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)' }}
              >
                <ArrowLeft size={18} />
              </button>
            )}
            {/* Logo si existe (prioriza rosa, sino verde) */}
            {(settings.rosa.logo || settings.verde.logo) && (
              <div
                className="w-11 h-11 rounded-full overflow-hidden flex-shrink-0"
                style={{
                  background: '#fff',
                  border: `1.5px solid ${themes.rosa.accent}`,
                  boxShadow: `0 4px 12px ${themes.rosa.accent}33`,
                }}
              >
                <img
                  src={settings.rosa.logo || settings.verde.logo!}
                  alt="logo"
                  className="w-full h-full object-cover"
                />
              </div>
            )}
            <div>
              <div
                className="text-2xl sm:text-3xl leading-none"
                style={{
                  fontFamily: '"Cormorant Garamond", serif',
                  fontStyle: 'italic',
                  fontWeight: 700,
                  background: `linear-gradient(135deg, ${themes.rosa.accent} 0%, ${themes.rosa.primaryDark} 50%, ${themes.verde.primaryDark} 100%)`,
                  WebkitBackgroundClip: 'text',
                  backgroundClip: 'text',
                  color: 'transparent',
                }}
              >
                {settings.rosa.businessName || 'Ginails'} VIP
              </div>
              <div className="text-[10px] tracking-[0.3em] uppercase opacity-60 mt-0.5">
                Loyalty · Premium
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setView('crm')}
              className="p-2.5 rounded-full transition-all hover:scale-110 relative"
              style={{ background: dark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)' }}
              aria-label="CRM · Fidelización"
            >
              <Bell size={18} />
              {crmAlerts.filter(a => a.priority === 1).length > 0 && (
                <span
                  className="absolute -top-0.5 -right-0.5 w-4 h-4 rounded-full flex items-center justify-center text-[9px] font-bold"
                  style={{
                    background: 'linear-gradient(135deg, #C14B5C 0%, #D4AF7F 100%)',
                    color: '#fff',
                    boxShadow: '0 2px 6px rgba(193,75,92,0.5)',
                  }}
                >
                  {crmAlerts.filter(a => a.priority === 1).length}
                </span>
              )}
            </button>
            <button
              onClick={() => setView('stats')}
              className="p-2.5 rounded-full transition-all hover:scale-110"
              style={{ background: dark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)' }}
              aria-label="Estadísticas"
            >
              <BarChart3 size={18} />
            </button>
            <button
              onClick={() => setView('settings')}
              className="p-2.5 rounded-full transition-all hover:scale-110"
              style={{ background: dark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)' }}
              aria-label="Configuración"
            >
              <Settings size={18} />
            </button>
            <button
              onClick={() => setSettings(s => ({ ...s, darkMode: !s.darkMode }))}
              className="p-2.5 rounded-full transition-all hover:scale-110"
              style={{ background: dark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)' }}
              aria-label="Modo oscuro"
            >
              {dark ? <Sun size={18} /> : <Moon size={18} />}
            </button>
          </div>
        </div>
      </header>

      {/* MAIN */}
      <main className="relative z-10 max-w-6xl mx-auto px-4 sm:px-6 py-6 pb-32">
        <AnimatePresence mode="wait">
          {/* ─────────── DASHBOARD ─────────── */}
          {view === 'dashboard' && (
            <motion.div
              key="dashboard"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              transition={{ duration: 0.4 }}
            >
              {/* CRM Alerts strip — top of dashboard */}
              {crmAlerts.length > 0 && (
                <CRMAlertsStrip
                  alerts={crmAlerts.slice(0, 6)}
                  clients={clients}
                  totalAlerts={crmAlerts.length}
                  dark={dark}
                  onOpenCRM={() => setView('crm')}
                  onOpenClient={(id) => { setActiveClientId(id); setView('detail'); }}
                  onSendWhatsApp={(alert) => {
                    const c = clients.find(cl => cl.id === alert.clientId);
                    if (!c) return;
                    const phone = (c.phone || '').replace(/\D/g, '');
                    const url = phone
                      ? `https://wa.me/${phone}?text=${encodeURIComponent(alert.whatsappTemplate)}`
                      : `https://wa.me/?text=${encodeURIComponent(alert.whatsappTemplate)}`;
                    window.open(url, '_blank');
                  }}
                />
              )}

              {/* Hero stats */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
                <StatCard label="Clientas" value={stats.total} icon={Users} dark={dark} />
                <StatCard label="Activas" value={stats.active} icon={TrendingUp} dark={dark} />
                <StatCard label="Premios" value={stats.completed} icon={Award} dark={dark} />
                <StatCard label="Visitas" value={stats.totalVisits} icon={CheckCircle2} dark={dark} />
              </div>

              {/* Search & filters */}
              <div className="flex flex-col sm:flex-row gap-3 mb-6">
                <div className="relative flex-1">
                  <Search size={16} className="absolute left-4 top-1/2 -translate-y-1/2 opacity-50" />
                  <input
                    type="text"
                    placeholder="Buscar clienta…"
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    className="w-full pl-11 pr-4 py-3 rounded-2xl outline-none border transition-all focus:scale-[1.01]"
                    style={{
                      background: dark ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.7)',
                      borderColor: dark ? 'rgba(232,180,192,0.15)' : 'rgba(212,175,127,0.25)',
                      backdropFilter: 'blur(10px)',
                    }}
                  />
                </div>
                <div className="flex gap-2 flex-wrap">
                  <FilterPill active={filterBrand === 'all'} onClick={() => setFilterBrand('all')} dark={dark}>Todas</FilterPill>
                  <FilterPill active={filterBrand === 'rosa'} onClick={() => setFilterBrand('rosa')} dark={dark} color="#E8B4C0">Uñas</FilterPill>
                  <FilterPill active={filterBrand === 'verde'} onClick={() => setFilterBrand('verde')} dark={dark} color="#B8C9A8">Corporal</FilterPill>
                </div>
              </div>

              {/* Status tabs */}
              <div className="flex gap-2 mb-5 overflow-x-auto pb-1">
                {(['all', 'active', 'complete'] as const).map(s => (
                  <button
                    key={s}
                    onClick={() => setFilterStatus(s)}
                    className="px-4 py-1.5 rounded-full text-xs tracking-wider uppercase font-medium whitespace-nowrap transition-all"
                    style={{
                      background: filterStatus === s
                        ? 'linear-gradient(135deg, #D4AF7F 0%, #C98AA0 100%)'
                        : (dark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)'),
                      color: filterStatus === s ? '#fff' : 'inherit',
                    }}
                  >
                    {s === 'all' ? 'Todas' : s === 'active' ? 'En progreso' : 'Premio listo'}
                  </button>
                ))}
              </div>

              {/* Client grid */}
              {filteredClients.length === 0 ? (
                <EmptyState dark={dark} hasClients={clients.length > 0} onAdd={() => setShowAddModal(true)} />
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                  {filteredClients.map((c, idx) => (
                    <motion.button
                      key={c.id}
                      initial={{ opacity: 0, y: 20 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: idx * 0.04, duration: 0.3 }}
                      onClick={() => { setActiveClientId(c.id); setView('detail'); }}
                      className="text-left rounded-3xl p-5 transition-all hover:scale-[1.02] hover:-translate-y-1 group relative overflow-hidden"
                      style={{
                        background: dark ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.7)',
                        backdropFilter: 'blur(20px)',
                        border: `1px solid ${dark ? 'rgba(232,180,192,0.12)' : 'rgba(212,175,127,0.18)'}`,
                        boxShadow: dark
                          ? '0 8px 32px rgba(0,0,0,0.3)'
                          : '0 8px 32px rgba(212,175,127,0.08)',
                      }}
                    >
                      {/* Brand stripe */}
                      <div
                        className="absolute top-0 left-0 right-0 h-1"
                        style={{ background: themes[c.brand].foil }}
                      />
                      <div className="flex items-start justify-between mb-3 mt-1">
                        <div className="flex items-center gap-3">
                          <div
                            className="w-12 h-12 rounded-full flex items-center justify-center text-xl"
                            style={{
                              background: themes[c.brand].gradient,
                              fontFamily: '"Cormorant Garamond", serif',
                              fontWeight: 700,
                              color: themes[c.brand].primaryDark,
                            }}
                          >
                            {c.name.charAt(0).toUpperCase()}
                          </div>
                          <div>
                            <div
                              className="text-lg leading-tight"
                              style={{ fontFamily: '"Cormorant Garamond", serif', fontWeight: 600 }}
                            >
                              {c.name}
                            </div>
                            <div className="text-[10px] tracking-widest uppercase opacity-60">
                              {c.brand === 'rosa' ? 'Uñas' : 'Corporal & Facial'}
                            </div>
                          </div>
                        </div>
                        {c.visits.length >= c.goal && (
                          <Crown size={16} style={{ color: themes[c.brand].accent }} />
                        )}
                      </div>

                      <div className="flex items-end justify-between mb-2">
                        <div>
                          <div
                            className="text-3xl leading-none"
                            style={{ fontFamily: '"Cormorant Garamond", serif', fontWeight: 700 }}
                          >
                            {c.visits.length}
                            <span className="opacity-40 text-xl"> / {c.goal}</span>
                          </div>
                          <div className="text-[10px] tracking-widest uppercase opacity-60 mt-1">visitas</div>
                        </div>
                        <ChevronRight size={20} className="opacity-30 group-hover:opacity-100 group-hover:translate-x-1 transition-all" />
                      </div>

                      <div className="h-1 rounded-full overflow-hidden mt-2" style={{ background: dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)' }}>
                        <div
                          className="h-full transition-all duration-700"
                          style={{
                            width: `${Math.min(100, (c.visits.length / c.goal) * 100)}%`,
                            background: themes[c.brand].foil,
                          }}
                        />
                      </div>
                    </motion.button>
                  ))}
                </div>
              )}
            </motion.div>
          )}

          {/* ─────────── DETAIL ─────────── */}
          {view === 'detail' && activeClient && (
            <motion.div
              key={`detail-${activeClient.id}`}
              initial={{ opacity: 0, scale: 0.96 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.96 }}
              transition={{ duration: 0.3 }}
              className="max-w-2xl mx-auto"
            >
              {/* Card */}
              <div className="mb-6">
                <VIPCard
                  client={activeClient}
                  businessName={settings[activeClient.brand].businessName}
                  rewardText={settings[activeClient.brand].rewardText}
                  logo={settings[activeClient.brand].logo}
                  theme={themes[activeClient.brand]}
                  customStamps={settings.customStamps}
                  cardSubtitle={settings.cardSubtitle}
                  cardRef={cardRef}
                />
              </div>

              {/* Action buttons */}
              <div className="grid grid-cols-2 gap-3 mb-6">
                {activeClient.visits.length < activeClient.goal ? (
                  <button
                    onClick={() => { setStampPickerMode('now'); setShowStampPicker(true); }}
                    className="col-span-2 py-4 rounded-2xl font-medium tracking-wide flex items-center justify-center gap-2 transition-all hover:scale-[1.02] active:scale-95"
                    style={{
                      background: 'linear-gradient(135deg, #D4AF7F 0%, #C98AA0 100%)',
                      color: '#fff',
                      boxShadow: '0 10px 30px rgba(201,138,160,0.4)',
                    }}
                  >
                    <Plus size={18} /> Marcar nueva visita
                  </button>
                ) : (
                  <button
                    onClick={() => toggleRewardClaimed(activeClient.id)}
                    className="col-span-2 py-4 rounded-2xl font-medium tracking-wide flex items-center justify-center gap-2 transition-all hover:scale-[1.02] active:scale-95"
                    style={{
                      background: activeClient.rewardClaimed
                        ? (dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)')
                        : 'linear-gradient(135deg, #D4AF7F 0%, #C98AA0 100%)',
                      color: activeClient.rewardClaimed ? 'inherit' : '#fff',
                      boxShadow: activeClient.rewardClaimed ? 'none' : '0 10px 30px rgba(201,138,160,0.4)',
                    }}
                  >
                    {activeClient.rewardClaimed ? (
                      <><CheckCircle2 size={18} /> Premio entregado</>
                    ) : (
                      <><Gift size={18} /> Marcar premio entregado</>
                    )}
                  </button>
                )}

                {activeClient.visits.length < activeClient.goal && (
                  <ActionBtn
                    dark={dark}
                    onClick={() => { setStampPickerMode('backdated'); setShowStampPicker(true); }}
                    icon={Calendar}
                    label="Visita anterior"
                  />
                )}
                <ActionBtn dark={dark} onClick={shareWhatsApp} icon={MessageCircle} label="Mensaje" />
                <ActionBtn dark={dark} onClick={() => setShowQRModal(true)} icon={QrCode} label="QR Code" />
                <ActionBtn
                  dark={dark}
                  onClick={shareCard}
                  icon={Share2}
                  label={sharingCard ? 'Enviando…' : 'Enviar tarjeta'}
                />
                <ActionBtn dark={dark} onClick={() => { setEditingClient(activeClient); setShowAddModal(true); }} icon={Edit3} label="Editar" />
                <ActionBtn dark={dark} onClick={() => deleteClient(activeClient.id)} icon={Trash2} label="Eliminar" danger />
              </div>

              {/* Visit history */}
              {activeClient.visits.length > 0 && (
                <div
                  className="rounded-3xl p-5"
                  style={{
                    background: dark ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.7)',
                    backdropFilter: 'blur(20px)',
                    border: `1px solid ${dark ? 'rgba(232,180,192,0.12)' : 'rgba(212,175,127,0.18)'}`,
                  }}
                >
                  <div className="text-xs tracking-[0.25em] uppercase opacity-60 mb-3 flex items-center gap-2">
                    <Calendar size={14} /> Historial de visitas
                  </div>
                  <p className="text-[10px] opacity-50 -mt-1.5 mb-3">Tocá una visita para editar la fecha</p>
                  <div className="space-y-2">
                    {[...activeClient.visits].map((v, originalIdx) => ({ v, originalIdx })).reverse().map(({ v, originalIdx }, i) => (
                      <button
                        key={originalIdx}
                        onClick={() => setEditingVisitIndex(originalIdx)}
                        className="w-full flex items-center justify-between py-2 px-3 rounded-xl text-sm transition-all hover:scale-[1.01] active:scale-95"
                        style={{ background: dark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.025)' }}
                      >
                        <span style={{ fontFamily: '"Cormorant Garamond", serif', fontStyle: 'italic', fontSize: '1.05rem' }}>
                          Visita #{originalIdx + 1}
                        </span>
                        <span className="flex items-center gap-2 opacity-70 text-xs">
                          {formatDateLong(v.date)}
                          <Edit3 size={12} className="opacity-50" />
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {activeClient.notes && (
                <div className="mt-4 rounded-3xl p-5"
                  style={{
                    background: dark ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.7)',
                    backdropFilter: 'blur(20px)',
                    border: `1px solid ${dark ? 'rgba(232,180,192,0.12)' : 'rgba(212,175,127,0.18)'}`,
                  }}
                >
                  <div className="text-xs tracking-[0.25em] uppercase opacity-60 mb-2">Notas</div>
                  <p className="text-sm leading-relaxed opacity-85">{activeClient.notes}</p>
                </div>
              )}
            </motion.div>
          )}

          {/* ─────────── SETTINGS ─────────── */}
          {view === 'settings' && (
            <motion.div
              key="settings"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="max-w-2xl mx-auto space-y-5"
            >
              <h2 className="text-3xl mb-1" style={{ fontFamily: '"Cormorant Garamond", serif', fontWeight: 600, fontStyle: 'italic' }}>
                Personalización
              </h2>
              <p className="text-xs opacity-60 tracking-wider uppercase mb-3">
                Tu marca, tus colores, tu identidad
              </p>

              {(['rosa', 'verde'] as Brand[]).map(b => (
                <BrandSettingsCard
                  key={b}
                  brand={b}
                  config={settings[b]}
                  theme={themes[b]}
                  dark={dark}
                  onUpdate={(patch) => setSettings(s => ({ ...s, [b]: { ...s[b], ...patch } }))}
                  onReset={() => setSettings(s => ({ ...s, [b]: { ...DEFAULT_BRAND_CONFIG[b] } }))}
                />
              ))}

              <SettingsCard dark={dark} title="Texto de la tarjeta">
                <Field label="Subtítulo bajo el nombre del negocio (opcional)" dark={dark}>
                  <input
                    type="text"
                    value={settings.cardSubtitle || ''}
                    onChange={(e) => setSettings(s => ({ ...s, cardSubtitle: e.target.value }))}
                    className="input-style"
                    placeholder="Ej: Beauty Studio · Belleza Integral · (vacío)"
                    maxLength={32}
                  />
                </Field>
                <p className="text-[10px] opacity-50 mt-1">Aparece en la esquina superior derecha de la tarjeta. Dejá vacío para que no se muestre nada.</p>
              </SettingsCard>

              <CustomStampsCard
                dark={dark}
                stamps={settings.customStamps || []}
                onAdd={(stamp) => setSettings(s => ({ ...s, customStamps: [...(s.customStamps || []), stamp] }))}
                onRemove={(id) => setSettings(s => ({ ...s, customStamps: (s.customStamps || []).filter(cs => cs.id !== id) }))}
                onRename={(id, label) => setSettings(s => ({ ...s, customStamps: (s.customStamps || []).map(cs => cs.id === id ? { ...cs, label } : cs) }))}
              />

              <SettingsCard dark={dark} title="Datos">
                <button
                  onClick={exportCSV}
                  className="w-full py-3 rounded-2xl flex items-center justify-center gap-2 transition-all hover:scale-[1.01]"
                  style={{
                    background: 'linear-gradient(135deg, #D4AF7F 0%, #C98AA0 100%)',
                    color: '#fff',
                  }}
                >
                  <Download size={16} /> Exportar clientas (CSV)
                </button>
                <button
                  onClick={() => askConfirm({
                    title: '¿Borrar todos los datos?',
                    message: 'Se eliminarán TODAS las clientas y sus visitas. Esta acción no se puede deshacer.',
                    confirmLabel: 'Sí, borrar todo',
                    danger: true,
                    onConfirm: () => actions.clearAllClients(),
                  })}
                  className="w-full py-3 mt-2 rounded-2xl flex items-center justify-center gap-2 transition-all hover:scale-[1.01]"
                  style={{
                    background: dark ? 'rgba(255,100,100,0.1)' : 'rgba(220,80,80,0.08)',
                    color: '#c14',
                  }}
                >
                  <Trash2 size={16} /> Borrar todos los datos
                </button>
              </SettingsCard>
            </motion.div>
          )}

          {/* ─────────── STATS ─────────── */}
          {view === 'stats' && (
            <motion.div
              key="stats"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="max-w-2xl mx-auto space-y-5"
            >
              <h2 className="text-3xl mb-2" style={{ fontFamily: '"Cormorant Garamond", serif', fontWeight: 600, fontStyle: 'italic' }}>
                Estadísticas de fidelización
              </h2>

              <div className="grid grid-cols-2 gap-3">
                <BigStat dark={dark} label="Clientas totales" value={stats.total} />
                <BigStat dark={dark} label="Promedio visitas" value={stats.avgVisits} />
                <BigStat dark={dark} label="En progreso" value={stats.active} />
                <BigStat dark={dark} label="Premios listos" value={stats.completed} />
              </div>

              <div
                className="rounded-3xl p-6"
                style={{
                  background: dark ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.7)',
                  backdropFilter: 'blur(20px)',
                  border: `1px solid ${dark ? 'rgba(232,180,192,0.12)' : 'rgba(212,175,127,0.18)'}`,
                }}
              >
                <div className="text-xs tracking-[0.25em] uppercase opacity-60 mb-4">Distribución por marca</div>
                <BrandBar label="Uñas (Rosa)" value={stats.rosaCount} total={stats.total} color="#E8B4C0" dark={dark} />
                <BrandBar label="Corporal & Facial (Verde)" value={stats.verdeCount} total={stats.total} color="#B8C9A8" dark={dark} />
              </div>

              <div
                className="rounded-3xl p-6 text-center"
                style={{
                  background: 'linear-gradient(135deg, rgba(212,175,127,0.15) 0%, rgba(201,138,160,0.15) 100%)',
                  border: `1px solid rgba(212,175,127,0.3)`,
                }}
              >
                <div className="text-xs tracking-[0.25em] uppercase opacity-60 mb-2">Total de visitas registradas</div>
                <div className="text-5xl" style={{ fontFamily: '"Cormorant Garamond", serif', fontWeight: 700 }}>
                  {stats.totalVisits}
                </div>
                <div className="text-xs opacity-60 mt-1 italic">cada una vale oro ✦</div>
              </div>
            </motion.div>
          )}

          {/* ─────────── CRM ─────────── */}
          {view === 'crm' && (
            <CRMView
              key="crm"
              alerts={crmAlerts}
              metrics={crmMetrics}
              topByVisits={topByVisits}
              clients={clients}
              thresholds={crmThresholds}
              dark={dark}
              onUpdateThresholds={(patch) =>
                setSettings(s => ({ ...s, crmThresholds: { ...DEFAULT_CRM_THRESHOLDS, ...(s.crmThresholds || {}), ...patch } }))
              }
              onOpenClient={(id) => { setActiveClientId(id); setView('detail'); }}
              onSendWhatsApp={(alert) => {
                const c = clients.find(cl => cl.id === alert.clientId);
                if (!c) return;
                const phone = (c.phone || '').replace(/\D/g, '');
                const url = phone
                  ? `https://wa.me/${phone}?text=${encodeURIComponent(alert.whatsappTemplate)}`
                  : `https://wa.me/?text=${encodeURIComponent(alert.whatsappTemplate)}`;
                window.open(url, '_blank');
              }}
            />
          )}
        </AnimatePresence>
      </main>

      {/* FAB - Add client */}
      {view === 'dashboard' && (
        <button
          onClick={() => { setEditingClient(null); setShowAddModal(true); }}
          className="fixed bottom-6 right-6 z-30 w-16 h-16 rounded-full flex items-center justify-center transition-all hover:scale-110 active:scale-95"
          style={{
            background: 'linear-gradient(135deg, #D4AF7F 0%, #C98AA0 50%, #8FA378 100%)',
            color: '#fff',
            boxShadow: '0 15px 40px rgba(201,138,160,0.5), 0 0 0 4px rgba(255,255,255,0.4)',
          }}
        >
          <Plus size={26} />
        </button>
      )}

      {/* MODAL: Add / Edit client */}
      <AnimatePresence>
        {showAddModal && (
          <ClientModal
            dark={dark}
            client={editingClient}
            themes={themes}
            onClose={() => { setShowAddModal(false); setEditingClient(null); }}
            onSave={(data) => {
              saveClient(data);
              setShowAddModal(false);
              setEditingClient(null);
            }}
          />
        )}
      </AnimatePresence>

      {/* MODAL: Stamp picker (per-visit stamp selection) */}
      <AnimatePresence>
        {showStampPicker && activeClient && (
          <StampPickerModal
            client={activeClient}
            customStamps={settings.customStamps || []}
            theme={themes[activeClient.brand]}
            dark={dark}
            mode={stampPickerMode}
            onClose={() => setShowStampPicker(false)}
            onPick={(stamp, date) => addVisit(activeClient.id, stamp, date)}
          />
        )}
      </AnimatePresence>

      {/* MODAL: Edit visit (change date or delete) */}
      <AnimatePresence>
        {editingVisitIndex !== null && activeClient && activeClient.visits[editingVisitIndex] && (
          <EditVisitModal
            visit={activeClient.visits[editingVisitIndex]}
            visitNumber={editingVisitIndex + 1}
            dark={dark}
            onClose={() => setEditingVisitIndex(null)}
            onSave={(newDate) => {
              updateVisit(activeClient.id, editingVisitIndex, { date: newDate });
              setEditingVisitIndex(null);
            }}
            onDelete={() => {
              removeVisitAt(activeClient.id, editingVisitIndex);
              setEditingVisitIndex(null);
            }}
          />
        )}
      </AnimatePresence>

      {/* MODAL: QR */}
      <AnimatePresence>
        {showQRModal && activeClient && (
          <Modal onClose={() => setShowQRModal(false)} dark={dark}>
            <h3 className="text-2xl mb-1 text-center" style={{ fontFamily: '"Cormorant Garamond", serif', fontWeight: 600, fontStyle: 'italic' }}>
              QR personalizado
            </h3>
            <p className="text-xs text-center opacity-60 mb-5 tracking-wider uppercase">
              {activeClient.name}
            </p>
            <div className="flex justify-center mb-4">
              <div className="p-4 rounded-2xl" style={{ background: themes[activeClient.brand].bg }}>
                <img src={qrUrl} alt="QR" className="w-56 h-56" />
              </div>
            </div>
            <p className="text-xs opacity-60 text-center italic">
              La clienta puede escanear y ver su tarjeta sin instalar nada.
            </p>
          </Modal>
        )}
      </AnimatePresence>

      {/* Global confirm dialog (replaces window.confirm for mobile reliability) */}
      <ConfirmDialog
        open={confirmConfig !== null}
        title={confirmConfig?.title || ''}
        message={confirmConfig?.message}
        confirmLabel={confirmConfig?.confirmLabel}
        danger={confirmConfig?.danger ?? true}
        dark={dark}
        onConfirm={() => {
          confirmConfig?.onConfirm();
          setConfirmConfig(null);
        }}
        onCancel={() => setConfirmConfig(null)}
      />

      <style>{`
        .input-style {
          width: 100%;
          padding: 0.75rem 1rem;
          border-radius: 1rem;
          outline: none;
          border: 1px solid ${dark ? 'rgba(232,180,192,0.15)' : 'rgba(212,175,127,0.25)'};
          background: ${dark ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.6)'};
          color: inherit;
          font-family: 'Outfit', sans-serif;
          font-size: 0.95rem;
          transition: all 0.2s;
        }
        .input-style:focus {
          border-color: #D4AF7F;
          background: ${dark ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.85)'};
        }
        .input-style::placeholder {
          opacity: 0.4;
        }
      `}</style>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// SUB-COMPONENTS
// ═══════════════════════════════════════════════════════════════════
const StatCard: React.FC<{ label: string; value: number | string; icon: any; dark: boolean }> = ({ label, value, icon: Icon, dark }) => (
  <div
    className="rounded-2xl p-4 transition-all hover:scale-[1.03]"
    style={{
      background: dark ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.7)',
      backdropFilter: 'blur(20px)',
      border: `1px solid ${dark ? 'rgba(232,180,192,0.12)' : 'rgba(212,175,127,0.18)'}`,
    }}
  >
    <div className="flex items-center justify-between mb-2">
      <Icon size={16} style={{ color: '#D4AF7F' }} />
    </div>
    <div className="text-2xl sm:text-3xl leading-none" style={{ fontFamily: '"Cormorant Garamond", serif', fontWeight: 700 }}>
      {value}
    </div>
    <div className="text-[10px] tracking-widest uppercase opacity-60 mt-1">{label}</div>
  </div>
);

const FilterPill: React.FC<{ active: boolean; onClick: () => void; children: React.ReactNode; dark: boolean; color?: string }> = ({ active, onClick, children, dark, color }) => (
  <button
    onClick={onClick}
    className="px-4 py-3 rounded-2xl text-sm transition-all hover:scale-[1.03]"
    style={{
      background: active
        ? (color ? `linear-gradient(135deg, ${color}, ${color}dd)` : 'linear-gradient(135deg, #D4AF7F 0%, #C98AA0 100%)')
        : (dark ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.7)'),
      color: active ? '#fff' : 'inherit',
      backdropFilter: 'blur(10px)',
      border: `1px solid ${active ? 'transparent' : (dark ? 'rgba(232,180,192,0.12)' : 'rgba(212,175,127,0.2)')}`,
    }}
  >
    {children}
  </button>
);

const ActionBtn: React.FC<{ icon: any; label: string; onClick: () => void; dark: boolean; danger?: boolean }> = ({ icon: Icon, label, onClick, dark, danger }) => (
  <button
    onClick={onClick}
    className="py-3 rounded-2xl flex items-center justify-center gap-2 text-sm transition-all hover:scale-[1.02] active:scale-95"
    style={{
      background: dark ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.7)',
      backdropFilter: 'blur(10px)',
      border: `1px solid ${dark ? 'rgba(232,180,192,0.12)' : 'rgba(212,175,127,0.18)'}`,
      color: danger ? '#c14' : 'inherit',
    }}
  >
    <Icon size={16} /> {label}
  </button>
);

const SettingsCard: React.FC<{ title: string; children: React.ReactNode; dark: boolean; accent?: string }> = ({ title, children, dark, accent }) => (
  <div
    className="rounded-3xl p-6 relative overflow-hidden"
    style={{
      background: dark ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.7)',
      backdropFilter: 'blur(20px)',
      border: `1px solid ${dark ? 'rgba(232,180,192,0.12)' : 'rgba(212,175,127,0.18)'}`,
    }}
  >
    {accent && <div className="absolute top-0 left-0 right-0 h-1" style={{ background: accent }} />}
    <h3 className="text-xl mb-4" style={{ fontFamily: '"Cormorant Garamond", serif', fontWeight: 600, fontStyle: 'italic' }}>
      {title}
    </h3>
    <div className="space-y-3">{children}</div>
  </div>
);

const Field: React.FC<{ label: string; children: React.ReactNode; dark: boolean }> = ({ label, children, dark }) => (
  <label className="block">
    <span className="text-[10px] tracking-[0.2em] uppercase opacity-70 block mb-1.5">{label}</span>
    {children}
  </label>
);

const BigStat: React.FC<{ label: string; value: number | string; dark: boolean }> = ({ label, value, dark }) => (
  <div
    className="rounded-3xl p-6"
    style={{
      background: dark ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.7)',
      backdropFilter: 'blur(20px)',
      border: `1px solid ${dark ? 'rgba(232,180,192,0.12)' : 'rgba(212,175,127,0.18)'}`,
    }}
  >
    <div className="text-4xl mb-1" style={{ fontFamily: '"Cormorant Garamond", serif', fontWeight: 700 }}>
      {value}
    </div>
    <div className="text-[10px] tracking-widest uppercase opacity-60">{label}</div>
  </div>
);

const BrandBar: React.FC<{ label: string; value: number; total: number; color: string; dark: boolean }> = ({ label, value, total, color, dark }) => {
  const pct = total ? (value / total) * 100 : 0;
  return (
    <div className="mb-3 last:mb-0">
      <div className="flex justify-between text-xs mb-1.5">
        <span className="opacity-80">{label}</span>
        <span className="opacity-60">{value} ({pct.toFixed(0)}%)</span>
      </div>
      <div className="h-2 rounded-full overflow-hidden" style={{ background: dark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)' }}>
        <div
          className="h-full transition-all duration-700 rounded-full"
          style={{ width: `${pct}%`, background: color }}
        />
      </div>
    </div>
  );
};

// ═══════════════════════════════════════════════════════════════════
// BRAND SETTINGS CARD — logo upload, colors, live preview
// ═══════════════════════════════════════════════════════════════════
const BrandSettingsCard: React.FC<{
  brand: Brand;
  config: BrandConfig;
  theme: ReturnType<typeof themeService.build>;
  dark: boolean;
  onUpdate: (patch: Partial<BrandConfig>) => void;
  onReset: () => void;
}> = ({ brand, config, theme, dark, onUpdate, onReset }) => {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [uploadingLogo, setUploadingLogo] = useState(false);

  const handleLogoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    // Generous size limit since we resize anyway
    if (file.size > 10 * 1024 * 1024) {
      alert('La imagen es demasiado grande (máx 10 MB). Probá con otra.');
      return;
    }
    if (!file.type.startsWith('image/')) {
      alert('El archivo no parece ser una imagen.');
      return;
    }
    setUploadingLogo(true);
    try {
      // 512x512 is plenty for the logo on the card and dashboard header
      const optimized = await imageService.processFile(file, 512);
      onUpdate({ logo: optimized });
    } catch (err) {
      alert('No se pudo procesar la imagen. Probá con otra.');
    } finally {
      setUploadingLogo(false);
      // Reset input so the same file can be re-uploaded
      if (e.target) e.target.value = '';
    }
  };

  const palettes = COLOR_PALETTES.filter(p => p.brand === brand);
  const isCurrentPalette = (p: typeof palettes[0]) =>
    p.primary === config.primary && p.primaryDark === config.primaryDark && p.accent === config.accent;

  return (
    <div
      className="rounded-3xl overflow-hidden"
      style={{
        background: dark ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.7)',
        backdropFilter: 'blur(20px)',
        border: `1px solid ${dark ? 'rgba(232,180,192,0.12)' : 'rgba(212,175,127,0.18)'}`,
      }}
    >
      {/* Brand header strip */}
      <div className="h-1.5" style={{ background: theme.foil }} />

      <div className="p-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-xl" style={{ fontFamily: '"Cormorant Garamond", serif', fontWeight: 600, fontStyle: 'italic' }}>
              {brand === 'rosa' ? 'Marca · Uñas' : 'Marca · Corporal & Facial'}
            </h3>
            <p className="text-[10px] tracking-[0.25em] uppercase opacity-60 mt-0.5">
              {brand === 'rosa' ? 'Línea Rosa' : 'Línea Verde'}
            </p>
          </div>
          <button
            onClick={onReset}
            className="text-[10px] tracking-widest uppercase opacity-50 hover:opacity-100 transition-opacity"
          >
            Restablecer
          </button>
        </div>

        {/* Live mini-preview */}
        <div
          className="rounded-2xl p-4 mb-5 relative overflow-hidden"
          style={{
            background: theme.gradientPremium,
            color: theme.text,
            minHeight: 90,
            boxShadow: `0 10px 30px ${config.accent}22`,
          }}
        >
          <div className="flex items-center gap-3">
            {config.logo ? (
              <div
                className="w-14 h-14 rounded-full overflow-hidden flex-shrink-0"
                style={{
                  border: `1.5px solid ${config.accent}`,
                  background: '#fff',
                  boxShadow: `0 4px 12px ${config.accent}44`,
                }}
              >
                <img src={config.logo} alt="logo" className="w-full h-full object-cover" />
              </div>
            ) : (
              <div
                className="w-14 h-14 rounded-full flex items-center justify-center text-2xl flex-shrink-0"
                style={{
                  background: 'rgba(255,255,255,0.5)',
                  border: `1.5px dashed ${config.accent}88`,
                  fontFamily: '"Cormorant Garamond", serif',
                  fontWeight: 700,
                  color: config.primaryDark,
                }}
              >
                {config.businessName.charAt(0).toUpperCase()}
              </div>
            )}
            <div className="flex-1 min-w-0">
              <div className="text-[9px] tracking-[0.3em] uppercase opacity-70">VIP Member</div>
              <div
                className="text-xl truncate"
                style={{
                  fontFamily: '"Cormorant Garamond", serif',
                  fontWeight: 700,
                  background: theme.foil,
                  WebkitBackgroundClip: 'text',
                  backgroundClip: 'text',
                  color: 'transparent',
                }}
              >
                {config.businessName || 'Tu negocio'}
              </div>
              <div className="flex gap-1 mt-1.5">
                {[1,2,3,4,5].map(i => (
                  <div
                    key={i}
                    className="w-3.5 h-3.5 rounded-full"
                    style={{
                      background: i <= 3 ? theme.foil : 'transparent',
                      border: i <= 3 ? 'none' : `1px solid ${config.accent}66`,
                    }}
                  />
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Logo uploader */}
        <Field label="Logo del negocio" dark={dark}>
          <div className="flex items-center gap-3">
            <div
              className="w-16 h-16 rounded-2xl overflow-hidden flex items-center justify-center flex-shrink-0"
              style={{
                background: config.logo ? '#fff' : (dark ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.6)'),
                border: `1.5px ${config.logo ? 'solid' : 'dashed'} ${config.accent}88`,
              }}
            >
              {config.logo ? (
                <img src={config.logo} alt="logo" className="w-full h-full object-cover" />
              ) : (
                <Camera size={20} style={{ color: config.accent, opacity: 0.6 }} />
              )}
            </div>
            <div className="flex-1 flex flex-col gap-2">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                onChange={handleLogoUpload}
                className="hidden"
              />
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={uploadingLogo}
                className="py-2 px-3 rounded-xl text-xs transition-all hover:scale-[1.02] disabled:opacity-60"
                style={{
                  background: 'linear-gradient(135deg, #D4AF7F 0%, #C98AA0 100%)',
                  color: '#fff',
                }}
              >
                {uploadingLogo ? 'Procesando…' : (config.logo ? 'Cambiar logo' : 'Subir logo')}
              </button>
              {config.logo && (
                <button
                  onClick={() => onUpdate({ logo: null })}
                  className="py-1.5 px-3 rounded-xl text-[10px] tracking-wider uppercase opacity-60 hover:opacity-100 transition-opacity"
                  style={{
                    background: dark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.04)',
                  }}
                >
                  Quitar logo
                </button>
              )}
            </div>
          </div>
          <p className="text-[10px] opacity-50 mt-2">PNG o JPG, idealmente cuadrado · se optimiza automáticamente</p>
        </Field>

        <Field label="Nombre del negocio" dark={dark}>
          <input
            type="text"
            value={config.businessName}
            onChange={e => onUpdate({ businessName: e.target.value })}
            className="input-style"
            placeholder="Ginails"
          />
        </Field>

        <Field label="Texto del premio" dark={dark}>
          <input
            type="text"
            value={config.rewardText}
            onChange={e => onUpdate({ rewardText: e.target.value })}
            className="input-style"
            placeholder={brand === 'rosa' ? 'Manicura de regalo' : 'Sesión facial de cortesía'}
          />
        </Field>

        {/* Color palettes */}
        <Field label="Paletas de color" dark={dark}>
          <div className="grid grid-cols-2 gap-2">
            {palettes.map(p => {
              const active = isCurrentPalette(p);
              return (
                <button
                  key={p.name}
                  onClick={() => onUpdate({ primary: p.primary, primaryDark: p.primaryDark, accent: p.accent, bg: p.bg, textTone: p.textTone })}
                  className="rounded-xl p-3 transition-all hover:scale-[1.02] text-left relative overflow-hidden"
                  style={{
                    background: dark ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.6)',
                    border: `1.5px solid ${active ? p.accent : 'transparent'}`,
                  }}
                >
                  <div className="flex gap-1 mb-2">
                    <div className="w-5 h-5 rounded-full" style={{ background: p.primary }} />
                    <div className="w-5 h-5 rounded-full" style={{ background: p.primaryDark }} />
                    <div className="w-5 h-5 rounded-full" style={{ background: p.accent }} />
                  </div>
                  <div className="text-xs font-medium">{p.name}</div>
                  {active && (
                    <CheckCircle2 size={14} style={{ color: p.accent }} className="absolute top-2 right-2" />
                  )}
                </button>
              );
            })}
          </div>
        </Field>

        {/* Custom color pickers */}
        <Field label="Personalizar colores" dark={dark}>
          <div className="grid grid-cols-3 gap-2">
            <ColorInput label="Primario" value={config.primary} onChange={(v) => onUpdate({ primary: v })} dark={dark} />
            <ColorInput label="Oscuro" value={config.primaryDark} onChange={(v) => onUpdate({ primaryDark: v })} dark={dark} />
            <ColorInput label="Dorado" value={config.accent} onChange={(v) => onUpdate({ accent: v })} dark={dark} />
          </div>
        </Field>
      </div>
    </div>
  );
};

// Color input — circular swatch + hex
const ColorInput: React.FC<{ label: string; value: string; onChange: (v: string) => void; dark: boolean }> = ({ label, value, onChange, dark }) => (
  <label
    className="rounded-xl p-2.5 transition-all hover:scale-[1.02] cursor-pointer block"
    style={{
      background: dark ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.6)',
      border: `1px solid ${dark ? 'rgba(232,180,192,0.12)' : 'rgba(212,175,127,0.18)'}`,
    }}
  >
    <div className="text-[9px] tracking-widest uppercase opacity-60 mb-1.5">{label}</div>
    <div className="flex items-center gap-2">
      <div
        className="w-7 h-7 rounded-full flex-shrink-0 relative overflow-hidden"
        style={{ background: value, border: `1.5px solid ${dark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.1)'}` }}
      >
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="absolute inset-0 opacity-0 cursor-pointer w-full h-full"
        />
      </div>
      <span className="text-[10px] font-mono opacity-70 truncate">{value.toUpperCase()}</span>
    </div>
  </label>
);

// ═══════════════════════════════════════════════════════════════════
// CUSTOM STAMPS CARD — manage uploaded mini-logos
// ═══════════════════════════════════════════════════════════════════
const CustomStampsCard: React.FC<{
  dark: boolean;
  stamps: CustomStamp[];
  onAdd: (stamp: CustomStamp) => void;
  onRemove: (id: string) => void;
  onRename: (id: string, label: string) => void;
}> = ({ dark, stamps, onAdd, onRemove, onRename }) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingLabel, setEditingLabel] = useState('');
  const [uploading, setUploading] = useState(false);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) {
      alert('La imagen es demasiado grande (máx 10 MB). Probá con otra.');
      if (e.target) e.target.value = '';
      return;
    }
    if (!file.type.startsWith('image/')) {
      alert('El archivo no parece ser una imagen.');
      if (e.target) e.target.value = '';
      return;
    }
    setUploading(true);
    try {
      // 256x256 is plenty for stamps (rendered at ~14px in the card)
      const optimized = await imageService.processFile(file, 256);
      const defaultLabel = file.name.replace(/\.[^/.]+$/, '').slice(0, 20);
      onAdd({
        id: 'cs_' + Math.random().toString(36).slice(2) + Date.now().toString(36),
        label: defaultLabel || 'Logo',
        image: optimized,
        createdAt: new Date().toISOString(),
      });
    } catch (err) {
      alert('No se pudo procesar la imagen. Probá con otra.');
    } finally {
      setUploading(false);
      if (e.target) e.target.value = '';
    }
  };

  return (
    <SettingsCard dark={dark} title="Sellos personalizados">
      <p className="text-xs opacity-65 leading-relaxed -mt-2 mb-2">
        Subí mini-logos para usar como sellos en cada visita. Útil para mezclar servicios en una misma tarjeta (ej: rosa para uñas, verde para facial).
      </p>

      {stamps.length > 0 ? (
        <div className="grid grid-cols-3 gap-2 mb-3">
          {stamps.map(cs => (
            <div
              key={cs.id}
              className="rounded-2xl p-3 flex flex-col items-center gap-2 transition-all hover:scale-[1.02]"
              style={{
                background: dark ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.6)',
                border: `1px solid ${dark ? 'rgba(232,180,192,0.12)' : 'rgba(212,175,127,0.18)'}`,
              }}
            >
              <div
                className="w-14 h-14 rounded-full overflow-hidden flex items-center justify-center"
                style={{ background: '#fff', border: `1.5px solid #D4AF7F88` }}
              >
                <img src={cs.image} alt={cs.label} className="w-full h-full object-contain" />
              </div>
              {editingId === cs.id ? (
                <input
                  type="text"
                  value={editingLabel}
                  onChange={(e) => setEditingLabel(e.target.value)}
                  onBlur={() => { onRename(cs.id, editingLabel.trim() || 'Logo'); setEditingId(null); }}
                  onKeyDown={(e) => { if (e.key === 'Enter') { onRename(cs.id, editingLabel.trim() || 'Logo'); setEditingId(null); } }}
                  autoFocus
                  className="text-xs text-center w-full bg-transparent outline-none border-b"
                  style={{ borderColor: '#D4AF7F88' }}
                  maxLength={20}
                />
              ) : (
                <button
                  onClick={() => { setEditingId(cs.id); setEditingLabel(cs.label); }}
                  className="text-xs opacity-80 hover:opacity-100 truncate w-full text-center"
                  title="Tocá para editar el nombre"
                >
                  {cs.label}
                </button>
              )}
              {confirmingDeleteId === cs.id ? (
                <div className="flex gap-1 w-full">
                  <button
                    onClick={() => setConfirmingDeleteId(null)}
                    className="flex-1 text-[10px] py-1 rounded-lg transition-all"
                    style={{ background: dark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)' }}
                  >
                    No
                  </button>
                  <button
                    onClick={() => { onRemove(cs.id); setConfirmingDeleteId(null); }}
                    className="flex-1 text-[10px] py-1 rounded-lg font-semibold transition-all"
                    style={{ background: 'linear-gradient(135deg, #C14B5C 0%, #D69A4E 100%)', color: '#fff' }}
                  >
                    Sí
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setConfirmingDeleteId(cs.id)}
                  className="text-[10px] opacity-50 hover:opacity-100 transition-opacity"
                  style={{ color: '#c14' }}
                >
                  Eliminar
                </button>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div
          className="rounded-2xl p-5 text-center mb-3"
          style={{
            background: dark ? 'rgba(255,255,255,0.02)' : 'rgba(255,255,255,0.4)',
            border: `1px dashed ${dark ? 'rgba(232,180,192,0.2)' : 'rgba(212,175,127,0.3)'}`,
          }}
        >
          <Camera size={20} className="mx-auto mb-2" style={{ color: '#D4AF7F', opacity: 0.6 }} />
          <p className="text-xs opacity-60">Aún no subiste sellos personalizados</p>
        </div>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        onChange={handleUpload}
        className="hidden"
      />
      <button
        onClick={() => fileInputRef.current?.click()}
        disabled={uploading}
        className="w-full py-3 rounded-2xl flex items-center justify-center gap-2 transition-all hover:scale-[1.01] disabled:opacity-60"
        style={{
          background: 'linear-gradient(135deg, #D4AF7F 0%, #C98AA0 100%)',
          color: '#fff',
        }}
      >
        {uploading ? (
          <>Procesando…</>
        ) : (
          <><Plus size={16} /> Subir nuevo sello</>
        )}
      </button>
      <p className="text-[10px] opacity-50 mt-2 text-center">PNG o JPG · se optimiza automáticamente para que sea liviano</p>
    </SettingsCard>
  );
};

// ═══════════════════════════════════════════════════════════════════
// CRM — Alerts strip (dashboard summary, horizontal scroll)
// ═══════════════════════════════════════════════════════════════════
const CRMAlertsStrip: React.FC<{
  alerts: CRMAlert[];
  clients: Client[];
  totalAlerts: number;
  dark: boolean;
  onOpenCRM: () => void;
  onOpenClient: (id: string) => void;
  onSendWhatsApp: (alert: CRMAlert) => void;
}> = ({ alerts, clients, totalAlerts, dark, onOpenCRM, onOpenClient, onSendWhatsApp }) => {
  const clientById = useMemo(() => {
    const m = new Map<string, Client>();
    clients.forEach(c => m.set(c.id, c));
    return m;
  }, [clients]);

  return (
    <motion.div
      initial={{ opacity: 0, y: -10 }}
      animate={{ opacity: 1, y: 0 }}
      className="mb-6"
    >
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Bell size={14} style={{ color: '#D4AF7F' }} />
          <span className="text-[10px] tracking-[0.25em] uppercase opacity-70">
            Necesitan tu atención
          </span>
        </div>
        <button
          onClick={onOpenCRM}
          className="text-[10px] tracking-widest uppercase opacity-60 hover:opacity-100 transition-opacity flex items-center gap-1"
        >
          Ver todas {totalAlerts > 6 && <span>({totalAlerts})</span>}
          <ChevronRight size={12} />
        </button>
      </div>

      <div className="flex gap-3 overflow-x-auto pb-2 -mx-1 px-1 snap-x scrollbar-thin">
        {alerts.map((alert, idx) => {
          const c = clientById.get(alert.clientId);
          if (!c) return null;
          const meta = crmService.stateMeta[alert.state];
          return (
            <motion.div
              key={alert.clientId + alert.state}
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: idx * 0.04 }}
              className="flex-shrink-0 w-[260px] sm:w-[280px] rounded-2xl p-4 snap-start relative overflow-hidden"
              style={{
                background: dark ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.85)',
                backdropFilter: 'blur(20px)',
                border: `1px solid ${meta.color}40`,
                boxShadow: `0 8px 24px ${meta.color}20`,
              }}
            >
              {/* Color stripe top */}
              <div className="absolute top-0 left-0 right-0 h-1" style={{ background: meta.color }} />
              <div className="flex items-start justify-between mb-2 mt-1">
                <div className="flex items-center gap-2 flex-1 min-w-0">
                  <div
                    className="w-9 h-9 rounded-full flex items-center justify-center text-base flex-shrink-0"
                    style={{ background: meta.tint }}
                  >
                    {meta.emoji}
                  </div>
                  <button
                    onClick={() => onOpenClient(alert.clientId)}
                    className="text-left flex-1 min-w-0"
                  >
                    <div
                      className="text-base leading-tight truncate"
                      style={{ fontFamily: '"Cormorant Garamond", serif', fontWeight: 600, fontStyle: 'italic' }}
                    >
                      {c.name}
                    </div>
                    <div className="text-[9px] tracking-widest uppercase opacity-60">
                      {meta.label}
                    </div>
                  </button>
                </div>
              </div>
              <p className="text-xs opacity-80 leading-snug mb-3 line-clamp-2 min-h-[2.5em]">
                {alert.reason}
              </p>
              <button
                onClick={() => onSendWhatsApp(alert)}
                className="w-full py-2 rounded-xl text-xs flex items-center justify-center gap-1.5 transition-all hover:scale-[1.02] active:scale-95"
                style={{
                  background: `linear-gradient(135deg, ${meta.color} 0%, ${meta.color}cc 100%)`,
                  color: '#fff',
                }}
              >
                <MessageCircle size={13} /> Enviar WhatsApp
              </button>
            </motion.div>
          );
        })}
      </div>
    </motion.div>
  );
};

// ═══════════════════════════════════════════════════════════════════
// CRM — Full view (alerts + rankings + metrics)
// ═══════════════════════════════════════════════════════════════════
const CRMView: React.FC<{
  alerts: CRMAlert[];
  metrics: ReturnType<typeof crmService.metrics>;
  topByVisits: Client[];
  clients: Client[];
  thresholds: CRMThresholds;
  dark: boolean;
  onUpdateThresholds: (patch: Partial<CRMThresholds>) => void;
  onOpenClient: (id: string) => void;
  onSendWhatsApp: (alert: CRMAlert) => void;
}> = ({ alerts, metrics, topByVisits, clients, thresholds, dark, onUpdateThresholds, onOpenClient, onSendWhatsApp }) => {
  const clientById = useMemo(() => {
    const m = new Map<string, Client>();
    clients.forEach(c => m.set(c.id, c));
    return m;
  }, [clients]);

  // Group alerts by state for cleaner display
  const alertsByState = useMemo(() => {
    const groups: Record<string, CRMAlert[]> = {};
    alerts.forEach(a => {
      if (!groups[a.state]) groups[a.state] = [];
      groups[a.state].push(a);
    });
    return groups;
  }, [alerts]);

  const stateOrder: ClientState[] = ['near_reward', 'dormant', 'inactive', 'vip_top', 'frequent'];

  // Monthly activity max for bar scaling
  const maxMonthly = Math.max(1, ...metrics.monthlyActivity.map(m => m.count));

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -20 }}
      className="max-w-3xl mx-auto space-y-6"
    >
      <div>
        <h2 className="text-3xl mb-1" style={{ fontFamily: '"Cormorant Garamond", serif', fontWeight: 600, fontStyle: 'italic' }}>
          Panel de fidelización
        </h2>
        <p className="text-xs opacity-60 tracking-wider uppercase">
          Tu CRM VIP · acciones que importan hoy
        </p>
      </div>

      {/* ── State distribution ── */}
      <div
        className="rounded-3xl p-5"
        style={{
          background: dark ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.7)',
          backdropFilter: 'blur(20px)',
          border: `1px solid ${dark ? 'rgba(232,180,192,0.12)' : 'rgba(212,175,127,0.18)'}`,
        }}
      >
        <div className="text-[10px] tracking-[0.25em] uppercase opacity-60 mb-3 flex items-center gap-2">
          <Activity size={12} /> Distribución de clientas
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {(['vip_top', 'frequent', 'near_reward', 'active', 'inactive', 'dormant', 'new'] as ClientState[]).map(s => {
            const meta = crmService.stateMeta[s];
            const count = metrics.byState[s] || 0;
            return (
              <div
                key={s}
                className="rounded-xl p-3 flex items-center gap-2"
                style={{
                  background: count > 0 ? meta.tint + '88' : (dark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.025)'),
                  border: `1px solid ${count > 0 ? meta.color + '40' : 'transparent'}`,
                }}
              >
                <span className="text-base">{meta.emoji}</span>
                <div className="flex-1 min-w-0">
                  <div className="text-lg leading-none" style={{ fontFamily: '"Cormorant Garamond", serif', fontWeight: 700 }}>
                    {count}
                  </div>
                  <div className="text-[9px] tracking-widest uppercase opacity-70 truncate">
                    {meta.label}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Key metrics ── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <CRMMetric dark={dark} icon={Trophy} label="Premios entregados" value={metrics.rewardsDelivered} />
        <CRMMetric dark={dark} icon={Zap} label="Activas este mes" value={metrics.activeThisMonth} />
        <CRMMetric dark={dark} icon={CheckCircle2} label="Tasa finalización" value={`${metrics.completionRate.toFixed(0)}%`} />
        <CRMMetric dark={dark} icon={TrendingUp} label="Retención mensual" value={`${metrics.retentionRate.toFixed(0)}%`} />
      </div>

      {/* ── Alerts grouped by state ── */}
      {alerts.length > 0 ? (
        stateOrder.map(state => {
          const stateAlerts = alertsByState[state];
          if (!stateAlerts || stateAlerts.length === 0) return null;
          const meta = crmService.stateMeta[state];
          return (
            <div
              key={state}
              className="rounded-3xl overflow-hidden"
              style={{
                background: dark ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.7)',
                backdropFilter: 'blur(20px)',
                border: `1px solid ${meta.color}33`,
              }}
            >
              <div className="h-1" style={{ background: meta.color }} />
              <div className="p-5">
                <div className="flex items-center gap-2 mb-3">
                  <span className="text-lg">{meta.emoji}</span>
                  <h3 className="text-lg flex-1" style={{ fontFamily: '"Cormorant Garamond", serif', fontWeight: 600, fontStyle: 'italic' }}>
                    {meta.label}
                  </h3>
                  <span
                    className="text-[10px] tracking-widest uppercase font-semibold px-2 py-0.5 rounded-full"
                    style={{ background: meta.tint, color: meta.color }}
                  >
                    {stateAlerts.length}
                  </span>
                </div>
                <div className="space-y-2">
                  {stateAlerts.map(alert => {
                    const c = clientById.get(alert.clientId);
                    if (!c) return null;
                    return (
                      <div
                        key={alert.clientId}
                        className="rounded-2xl p-3 flex items-center gap-3"
                        style={{
                          background: dark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.025)',
                        }}
                      >
                        <button
                          onClick={() => onOpenClient(alert.clientId)}
                          className="flex-1 min-w-0 text-left"
                        >
                          <div
                            className="text-base leading-tight truncate"
                            style={{ fontFamily: '"Cormorant Garamond", serif', fontWeight: 600, fontStyle: 'italic' }}
                          >
                            {c.name}
                          </div>
                          <div className="text-[10px] opacity-65 truncate">
                            {alert.reason}
                          </div>
                        </button>
                        <button
                          onClick={() => onSendWhatsApp(alert)}
                          className="px-3 py-2 rounded-xl text-xs flex items-center gap-1.5 transition-all hover:scale-[1.03] active:scale-95 flex-shrink-0"
                          style={{
                            background: `linear-gradient(135deg, ${meta.color} 0%, ${meta.color}cc 100%)`,
                            color: '#fff',
                          }}
                          aria-label="Enviar WhatsApp"
                        >
                          <MessageCircle size={13} />
                          <span className="hidden sm:inline">WhatsApp</span>
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          );
        })
      ) : (
        <div
          className="rounded-3xl p-8 text-center"
          style={{
            background: dark ? 'rgba(255,255,255,0.03)' : 'rgba(255,255,255,0.5)',
            border: `1px dashed ${dark ? 'rgba(232,180,192,0.2)' : 'rgba(212,175,127,0.3)'}`,
          }}
        >
          <Sparkles size={20} className="mx-auto mb-2" style={{ color: '#D4AF7F', opacity: 0.6 }} />
          <p className="text-sm opacity-70">Todo bajo control · no hay alertas pendientes</p>
        </div>
      )}

      {/* ── Top clientas ── */}
      {topByVisits.length > 0 && (
        <div
          className="rounded-3xl p-5"
          style={{
            background: dark ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.7)',
            backdropFilter: 'blur(20px)',
            border: `1px solid ${dark ? 'rgba(232,180,192,0.12)' : 'rgba(212,175,127,0.18)'}`,
          }}
        >
          <div className="text-[10px] tracking-[0.25em] uppercase opacity-60 mb-3 flex items-center gap-2">
            <Trophy size={12} /> Top clientas
          </div>
          <div className="space-y-2">
            {topByVisits.map((c, i) => {
              const medals = ['🥇', '🥈', '🥉', '✨', '✨'];
              return (
                <button
                  key={c.id}
                  onClick={() => onOpenClient(c.id)}
                  className="w-full rounded-2xl p-3 flex items-center gap-3 text-left transition-all hover:scale-[1.01]"
                  style={{
                    background: dark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.025)',
                  }}
                >
                  <span className="text-lg">{medals[i] || '✨'}</span>
                  <div className="flex-1 min-w-0">
                    <div
                      className="text-base leading-tight truncate"
                      style={{ fontFamily: '"Cormorant Garamond", serif', fontWeight: 600, fontStyle: 'italic' }}
                    >
                      {c.name}
                    </div>
                    <div className="text-[10px] opacity-65">
                      {c.visits.length} {c.visits.length === 1 ? 'visita' : 'visitas'}
                    </div>
                  </div>
                  <ChevronRight size={16} className="opacity-30" />
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Monthly activity chart ── */}
      {metrics.monthlyActivity.some(m => m.count > 0) && (
        <div
          className="rounded-3xl p-5"
          style={{
            background: dark ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.7)',
            backdropFilter: 'blur(20px)',
            border: `1px solid ${dark ? 'rgba(232,180,192,0.12)' : 'rgba(212,175,127,0.18)'}`,
          }}
        >
          <div className="text-[10px] tracking-[0.25em] uppercase opacity-60 mb-4 flex items-center gap-2">
            <BarChart3 size={12} /> Actividad de los últimos 6 meses
          </div>
          <div className="flex items-end justify-between gap-2 h-32">
            {metrics.monthlyActivity.map((m, i) => {
              const heightPct = maxMonthly > 0 ? (m.count / maxMonthly) * 100 : 0;
              const isCurrent = i === metrics.monthlyActivity.length - 1;
              return (
                <div key={i} className="flex-1 flex flex-col items-center gap-1 h-full justify-end">
                  <div className="text-[10px] font-semibold opacity-70">{m.count}</div>
                  <div
                    className="w-full rounded-t-lg transition-all"
                    style={{
                      height: `${Math.max(4, heightPct)}%`,
                      background: isCurrent
                        ? 'linear-gradient(180deg, #D4AF7F 0%, #C98AA0 100%)'
                        : (dark ? 'rgba(232,180,192,0.3)' : 'rgba(212,175,127,0.4)'),
                    }}
                  />
                  <div className="text-[9px] tracking-widest uppercase opacity-60">{m.label}</div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Threshold settings inline ── */}
      <div
        className="rounded-3xl p-5"
        style={{
          background: dark ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.7)',
          backdropFilter: 'blur(20px)',
          border: `1px solid ${dark ? 'rgba(232,180,192,0.12)' : 'rgba(212,175,127,0.18)'}`,
        }}
      >
        <div className="text-[10px] tracking-[0.25em] uppercase opacity-60 mb-3 flex items-center gap-2">
          <Clock size={12} /> Umbrales del CRM
        </div>
        <p className="text-xs opacity-65 mb-4 leading-relaxed">
          Configurá cuándo se considera que una clienta necesita tu atención.
        </p>
        <div className="space-y-3">
          <ThresholdSlider
            dark={dark}
            label="Días sin venir → Inactiva"
            value={thresholds.inactiveDays}
            min={15} max={60} step={5}
            onChange={(v) => onUpdateThresholds({ inactiveDays: v })}
            suffix=" días"
          />
          <ThresholdSlider
            dark={dark}
            label="Días sin venir → Dormida (recuperación)"
            value={thresholds.dormantDays}
            min={45} max={180} step={15}
            onChange={(v) => onUpdateThresholds({ dormantDays: v })}
            suffix=" días"
          />
          <ThresholdSlider
            dark={dark}
            label="Visitas en 60 días → Frecuente"
            value={thresholds.frequentVisitsIn60d}
            min={2} max={8} step={1}
            onChange={(v) => onUpdateThresholds({ frequentVisitsIn60d: v })}
            suffix=" visitas"
          />
        </div>
      </div>
    </motion.div>
  );
};

const CRMMetric: React.FC<{ icon: any; label: string; value: number | string; dark: boolean }> = ({ icon: Icon, label, value, dark }) => (
  <div
    className="rounded-2xl p-4"
    style={{
      background: dark ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.7)',
      backdropFilter: 'blur(20px)',
      border: `1px solid ${dark ? 'rgba(232,180,192,0.12)' : 'rgba(212,175,127,0.18)'}`,
    }}
  >
    <Icon size={14} style={{ color: '#D4AF7F' }} className="mb-2" />
    <div className="text-2xl leading-none" style={{ fontFamily: '"Cormorant Garamond", serif', fontWeight: 700 }}>
      {value}
    </div>
    <div className="text-[10px] tracking-widest uppercase opacity-60 mt-1">{label}</div>
  </div>
);

const ThresholdSlider: React.FC<{
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix?: string;
  dark: boolean;
  onChange: (v: number) => void;
}> = ({ label, value, min, max, step, suffix, dark, onChange }) => (
  <div>
    <div className="flex items-center justify-between mb-1.5">
      <span className="text-xs opacity-80">{label}</span>
      <span
        className="text-xs font-semibold"
        style={{ color: '#C98AA0', fontFamily: '"Cormorant Garamond", serif', fontStyle: 'italic', fontSize: '1rem' }}
      >
        {value}{suffix}
      </span>
    </div>
    <input
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(e) => onChange(parseInt(e.target.value, 10))}
      className="w-full"
      style={{ accentColor: '#C98AA0' }}
    />
  </div>
);

const EmptyState: React.FC<{ dark: boolean; hasClients: boolean; onAdd: () => void }> = ({ dark, hasClients, onAdd }) => (
  <div
    className="rounded-3xl p-12 text-center"
    style={{
      background: dark ? 'rgba(255,255,255,0.03)' : 'rgba(255,255,255,0.5)',
      backdropFilter: 'blur(20px)',
      border: `1px dashed ${dark ? 'rgba(232,180,192,0.2)' : 'rgba(212,175,127,0.35)'}`,
    }}
  >
    <div className="inline-flex w-20 h-20 rounded-full items-center justify-center mb-4 mx-auto"
      style={{ background: 'linear-gradient(135deg, #FDE2E4 0%, #EEF2E4 100%)' }}>
      <Sparkles size={28} style={{ color: '#D4AF7F' }} />
    </div>
    <h3 className="text-2xl mb-2" style={{ fontFamily: '"Cormorant Garamond", serif', fontWeight: 600, fontStyle: 'italic' }}>
      {hasClients ? 'Sin resultados' : 'Tu primera clienta VIP'}
    </h3>
    <p className="text-sm opacity-70 max-w-sm mx-auto leading-relaxed mb-5">
      {hasClients
        ? 'No hay clientas que coincidan con esta búsqueda. Probá ajustar los filtros.'
        : 'Empezá a fidelizar a tus clientas con tarjetas digitales premium. Cada visita cuenta.'}
    </p>
    {!hasClients && (
      <button
        onClick={onAdd}
        className="px-6 py-3 rounded-2xl inline-flex items-center gap-2 transition-all hover:scale-[1.03]"
        style={{
          background: 'linear-gradient(135deg, #D4AF7F 0%, #C98AA0 100%)',
          color: '#fff',
          boxShadow: '0 10px 30px rgba(201,138,160,0.4)',
        }}
      >
        <Plus size={18} /> Agregar primera clienta
      </button>
    )}
  </div>
);

// ═══════════════════════════════════════════════════════════════════
// MODAL WRAPPER
// ═══════════════════════════════════════════════════════════════════
const Modal: React.FC<{ children: React.ReactNode; onClose: () => void; dark: boolean }> = ({ children, onClose, dark }) => (
  <motion.div
    initial={{ opacity: 0 }}
    animate={{ opacity: 1 }}
    exit={{ opacity: 0 }}
    className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4"
    style={{ background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(8px)' }}
    onClick={onClose}
  >
    <motion.div
      initial={{ y: '100%', opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      exit={{ y: '100%', opacity: 0 }}
      transition={{ type: 'spring', damping: 25, stiffness: 200 }}
      onClick={(e) => e.stopPropagation()}
      className="w-full sm:max-w-md rounded-t-[2rem] sm:rounded-3xl p-6 max-h-[90vh] overflow-y-auto"
      style={{
        background: dark ? '#1A1217' : '#FDF6F3',
        border: `1px solid ${dark ? 'rgba(232,180,192,0.15)' : 'rgba(212,175,127,0.25)'}`,
        boxShadow: '0 -20px 60px rgba(0,0,0,0.3)',
      }}
    >
      <div className="w-12 h-1 rounded-full mx-auto mb-5 sm:hidden" style={{ background: dark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.15)' }} />
      {children}
    </motion.div>
  </motion.div>
);

// ═══════════════════════════════════════════════════════════════════
// CONFIRM DIALOG — reliable replacement for window.confirm()
// ═══════════════════════════════════════════════════════════════════
// `confirm()` is unreliable on mobile browsers (sometimes silently blocked,
// sometimes not styled well). This is our visual replacement.
//
const ConfirmDialog: React.FC<{
  open: boolean;
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  dark: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}> = ({ open, title, message, confirmLabel = 'Sí, continuar', cancelLabel = 'Cancelar', danger = true, dark, onConfirm, onCancel }) => {
  return (
    <AnimatePresence>
      {open && (
        <Modal onClose={onCancel} dark={dark}>
          <h3 className="text-2xl mb-2 text-center" style={{ fontFamily: '"Cormorant Garamond", serif', fontWeight: 600, fontStyle: 'italic' }}>
            {title}
          </h3>
          {message && (
            <p className="text-sm text-center opacity-75 mb-5 leading-relaxed px-2">
              {message}
            </p>
          )}
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={onCancel}
              className="py-3 rounded-2xl transition-all hover:scale-[1.01] active:scale-95"
              style={{ background: dark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)' }}
            >
              {cancelLabel}
            </button>
            <button
              onClick={onConfirm}
              className="py-3 rounded-2xl font-semibold transition-all hover:scale-[1.01] active:scale-95"
              style={{
                background: danger
                  ? 'linear-gradient(135deg, #C14B5C 0%, #D69A4E 100%)'
                  : 'linear-gradient(135deg, #D4AF7F 0%, #C98AA0 100%)',
                color: '#fff',
                boxShadow: danger
                  ? '0 8px 24px rgba(193,75,92,0.35)'
                  : '0 8px 24px rgba(201,138,160,0.35)',
              }}
            >
              {confirmLabel}
            </button>
          </div>
        </Modal>
      )}
    </AnimatePresence>
  );
};

// ═══════════════════════════════════════════════════════════════════
// STAMP PICKER MODAL — choose which stamp marks this specific visit
// ═══════════════════════════════════════════════════════════════════
// Flow: tap "Marcar nueva visita" → this opens → pick a stamp → it gets
// recorded with the visit. Lets a single card mix services visually.
//
const POPULAR_EMOJIS = ['💅', '🌸', '🍃', '✨', '💎', '💗', '👑', '🌿', '💆', '🌷', '🪷', '☘️'];

const StampPickerModal: React.FC<{
  client: Client;
  customStamps: CustomStamp[];
  theme: ReturnType<typeof themeService.build>;
  dark: boolean;
  mode?: 'now' | 'backdated';
  onClose: () => void;
  onPick: (stamp: VisitStamp | undefined, date?: string) => void;
}> = ({ client, customStamps, theme, dark, mode = 'now', onClose, onPick }) => {
  // Default the backdated date input to today (YYYY-MM-DD)
  const todayStr = new Date().toISOString().slice(0, 10);
  const [pickedDate, setPickedDate] = useState(todayStr);
  const [step, setStep] = useState<'date' | 'stamp'>(mode === 'backdated' ? 'date' : 'stamp');

  // When picking, convert the YYYY-MM-DD into a noon-local ISO so timezone
  // shifts don't push the visit to the previous day.
  const buildIsoFromInput = (yyyymmdd: string): string => {
    const [y, m, d] = yyyymmdd.split('-').map(Number);
    const local = new Date(y, m - 1, d, 12, 0, 0); // noon local
    return local.toISOString();
  };

  const handlePick = (stamp: VisitStamp | undefined) => {
    if (mode === 'backdated') {
      onPick(stamp, buildIsoFromInput(pickedDate));
    } else {
      onPick(stamp, undefined);
    }
    onClose();
  };

  // ─── Step 1 (only in backdated mode): pick a date ───
  if (step === 'date') {
    return (
      <Modal onClose={onClose} dark={dark}>
        <h3 className="text-2xl mb-1 text-center" style={{ fontFamily: '"Cormorant Garamond", serif', fontWeight: 600, fontStyle: 'italic' }}>
          ¿Cuándo vino?
        </h3>
        <p className="text-xs text-center opacity-60 mb-5 tracking-wider uppercase">
          Elegí la fecha de la visita
        </p>
        <input
          type="date"
          value={pickedDate}
          max={todayStr}
          onChange={(e) => setPickedDate(e.target.value)}
          className="input-style mb-4 text-center"
          style={{ fontFamily: '"Cormorant Garamond", serif', fontSize: '1.15rem' }}
        />
        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={onClose}
            className="py-3 rounded-2xl transition-all hover:scale-[1.01]"
            style={{ background: dark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)' }}
          >
            Cancelar
          </button>
          <button
            onClick={() => setStep('stamp')}
            className="py-3 rounded-2xl transition-all hover:scale-[1.01]"
            style={{
              background: 'linear-gradient(135deg, #D4AF7F 0%, #C98AA0 100%)',
              color: '#fff',
              boxShadow: '0 8px 24px rgba(201,138,160,0.35)',
            }}
          >
            Continuar
          </button>
        </div>
      </Modal>
    );
  }

  // ─── Step 2: pick the stamp (icon, custom, emoji) ───
  return (
    <Modal onClose={onClose} dark={dark}>
      <h3 className="text-2xl mb-1 text-center" style={{ fontFamily: '"Cormorant Garamond", serif', fontWeight: 600, fontStyle: 'italic' }}>
        ¿Qué servicio se hizo?
      </h3>
      <p className="text-xs text-center opacity-60 mb-1 tracking-wider uppercase">
        Elegí el sello para esta visita
      </p>
      {mode === 'backdated' && (
        <button
          onClick={() => setStep('date')}
          className="text-[11px] block text-center mx-auto mb-4 opacity-65 hover:opacity-100 transition-opacity"
          style={{ color: '#C98AA0' }}
        >
          📅 Fecha: {new Date(buildIsoFromInput(pickedDate)).toLocaleDateString('es-AR', { day: 'numeric', month: 'long', year: 'numeric' })} · cambiar
        </button>
      )}
      {mode === 'now' && <div className="mb-4" />}

      {/* Default stamp option */}
      <button
        onClick={() => handlePick(undefined)}
        className="w-full py-3 px-4 rounded-2xl mb-4 flex items-center gap-3 transition-all hover:scale-[1.01] active:scale-95"
        style={{
          background: theme.gradient,
          color: theme.text,
          border: `1px solid ${theme.primaryDark}`,
        }}
      >
        <div
          className="w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0"
          style={{ background: theme.foil }}
        >
          {(() => {
            const Comp = STAMP_ICONS[client.stampIcon].component;
            return <Comp size={16} style={{ color: '#fff', fill: '#fff' }} />;
          })()}
        </div>
        <div className="text-left flex-1">
          <div style={{ fontFamily: '"Cormorant Garamond", serif', fontStyle: 'italic', fontWeight: 600, fontSize: '1.1rem' }}>
            Sello por defecto
          </div>
          <div className="text-[10px] tracking-widest uppercase opacity-70">El elegido al crear la tarjeta</div>
        </div>
      </button>

      {/* Custom stamps (uploaded logos) */}
      {customStamps.length > 0 && (
        <div className="mb-4">
          <div className="text-[10px] tracking-[0.25em] uppercase opacity-60 mb-2">Tus logos</div>
          <div className="grid grid-cols-4 gap-2">
            {customStamps.map(cs => (
              <button
                key={cs.id}
                onClick={() => handlePick({ kind: 'custom', id: cs.id })}
                className="aspect-square rounded-xl flex flex-col items-center justify-center p-2 transition-all hover:scale-[1.05] active:scale-95"
                style={{
                  background: dark ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.6)',
                  border: `1px solid ${dark ? 'rgba(232,180,192,0.12)' : 'rgba(212,175,127,0.18)'}`,
                }}
                title={cs.label}
              >
                <img src={cs.image} alt={cs.label} className="w-10 h-10 object-contain rounded-full" />
                <div className="text-[8px] tracking-wider uppercase opacity-60 mt-1 truncate w-full text-center">{cs.label}</div>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Built-in icons */}
      <div className="mb-4">
        <div className="text-[10px] tracking-[0.25em] uppercase opacity-60 mb-2">Íconos</div>
        <div className="grid grid-cols-4 gap-2">
          {(Object.keys(STAMP_ICONS) as StampIcon[]).map(id => {
            const Comp = STAMP_ICONS[id].component;
            return (
              <button
                key={id}
                onClick={() => handlePick({ kind: 'icon', id })}
                className="aspect-square rounded-xl flex items-center justify-center transition-all hover:scale-[1.05] active:scale-95"
                style={{
                  background: dark ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.6)',
                  border: `1px solid ${dark ? 'rgba(232,180,192,0.12)' : 'rgba(212,175,127,0.18)'}`,
                }}
              >
                <Comp size={20} style={{ color: theme.primaryDark, fill: theme.primaryDark, opacity: 0.85 }} />
              </button>
            );
          })}
        </div>
      </div>

      {/* Emojis */}
      <div className="mb-2">
        <div className="text-[10px] tracking-[0.25em] uppercase opacity-60 mb-2">Emojis</div>
        <div className="grid grid-cols-6 gap-2">
          {POPULAR_EMOJIS.map(char => (
            <button
              key={char}
              onClick={() => handlePick({ kind: 'emoji', char })}
              className="aspect-square rounded-xl flex items-center justify-center text-2xl transition-all hover:scale-[1.05] active:scale-95"
              style={{
                background: dark ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.6)',
                border: `1px solid ${dark ? 'rgba(232,180,192,0.12)' : 'rgba(212,175,127,0.18)'}`,
              }}
            >
              {char}
            </button>
          ))}
        </div>
      </div>
    </Modal>
  );
};

// ═══════════════════════════════════════════════════════════════════
// EDIT VISIT MODAL — change date of an existing visit, or delete it
// ═══════════════════════════════════════════════════════════════════
const EditVisitModal: React.FC<{
  visit: Visit;
  visitNumber: number;
  dark: boolean;
  onClose: () => void;
  onSave: (newDateISO: string) => void;
  onDelete: () => void;
}> = ({ visit, visitNumber, dark, onClose, onSave, onDelete }) => {
  // YYYY-MM-DD using local timezone (avoids the "back one day" bug from .toISOString)
  const initialDateStr = (() => {
    const d = new Date(visit.date);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  })();
  const [dateStr, setDateStr] = useState(initialDateStr);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const todayStr = new Date().toISOString().slice(0, 10);

  const handleSave = () => {
    const [y, m, d] = dateStr.split('-').map(Number);
    const local = new Date(y, m - 1, d, 12, 0, 0);
    onSave(local.toISOString());
  };

  return (
    <Modal onClose={onClose} dark={dark}>
      <h3 className="text-2xl mb-1 text-center" style={{ fontFamily: '"Cormorant Garamond", serif', fontWeight: 600, fontStyle: 'italic' }}>
        Editar visita #{visitNumber}
      </h3>
      <p className="text-xs text-center opacity-60 mb-5 tracking-wider uppercase">
        Cambiá la fecha o eliminá la visita
      </p>

      <Field label="Fecha de la visita" dark={dark}>
        <input
          type="date"
          value={dateStr}
          max={todayStr}
          onChange={(e) => setDateStr(e.target.value)}
          className="input-style text-center"
          style={{ fontFamily: '"Cormorant Garamond", serif', fontSize: '1.1rem' }}
        />
      </Field>

      <div className="grid grid-cols-2 gap-2 mt-5">
        <button
          onClick={onClose}
          className="py-3 rounded-2xl transition-all hover:scale-[1.01]"
          style={{ background: dark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)' }}
        >
          Cancelar
        </button>
        <button
          onClick={handleSave}
          disabled={!dateStr || dateStr === initialDateStr}
          className="py-3 rounded-2xl transition-all hover:scale-[1.01] disabled:opacity-40 disabled:cursor-not-allowed"
          style={{
            background: 'linear-gradient(135deg, #D4AF7F 0%, #C98AA0 100%)',
            color: '#fff',
            boxShadow: '0 8px 24px rgba(201,138,160,0.35)',
          }}
        >
          Guardar
        </button>
      </div>

      {/* Inline delete confirmation — works on every device, unlike confirm() */}
      {!confirmingDelete ? (
        <button
          onClick={() => setConfirmingDelete(true)}
          className="w-full mt-3 py-2 rounded-2xl text-xs flex items-center justify-center gap-1.5 transition-all hover:scale-[1.01] active:scale-95"
          style={{
            background: dark ? 'rgba(255,100,100,0.08)' : 'rgba(220,80,80,0.06)',
            color: '#c14',
          }}
        >
          <Trash2 size={13} /> Eliminar esta visita
        </button>
      ) : (
        <div
          className="mt-3 rounded-2xl p-3"
          style={{
            background: dark ? 'rgba(193,75,92,0.12)' : 'rgba(193,75,92,0.08)',
            border: '1px solid rgba(193,75,92,0.3)',
          }}
        >
          <p className="text-xs text-center mb-2" style={{ color: '#c14' }}>
            ¿Eliminar esta visita? No se puede deshacer.
          </p>
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => setConfirmingDelete(false)}
              className="py-2 rounded-xl text-xs transition-all hover:scale-[1.01]"
              style={{ background: dark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)' }}
            >
              No, cancelar
            </button>
            <button
              onClick={onDelete}
              className="py-2 rounded-xl text-xs font-semibold transition-all hover:scale-[1.01] active:scale-95"
              style={{
                background: 'linear-gradient(135deg, #C14B5C 0%, #D69A4E 100%)',
                color: '#fff',
              }}
            >
              Sí, eliminar
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
};

// ═══════════════════════════════════════════════════════════════════
// CLIENT MODAL — Add/Edit
// ═══════════════════════════════════════════════════════════════════
const ClientModal: React.FC<{
  client: Client | null;
  onClose: () => void;
  onSave: (data: any) => void;
  dark: boolean;
  themes: ReturnType<typeof themeService.buildAll>;
}> = ({ client, onClose, onSave, dark, themes }) => {
  const [name, setName] = useState(client?.name || '');
  const [phone, setPhone] = useState(client?.phone || '');
  const [notes, setNotes] = useState(client?.notes || '');
  const [brand, setBrand] = useState<Brand>(client?.brand || 'rosa');
  const [template, setTemplate] = useState<Template>(client?.template || 'elegante');
  const [stampIcon, setStampIcon] = useState<StampIcon>(client?.stampIcon || (client?.brand === 'verde' ? 'leaf' : 'heart'));
  const [goal, setGoal] = useState(client?.goal || 5);

  const handleSubmit = () => {
    if (!name.trim()) return;
    onSave({
      ...(client ? { id: client.id } : {}),
      name: name.trim(),
      phone: phone.trim() || undefined,
      notes: notes.trim() || undefined,
      brand,
      template,
      stampIcon,
      goal,
    });
  };

  const stampOptions: { id: StampIcon; rosaIcon: any; verdeIcon: any; label: string }[] = [
    { id: 'heart', rosaIcon: Heart, verdeIcon: Leaf, label: 'Corazón / Hoja' },
    { id: 'gem', rosaIcon: Gem, verdeIcon: Gem, label: 'Diamante' },
    { id: 'star', rosaIcon: Star, verdeIcon: Star, label: 'Estrella' },
    { id: 'flower', rosaIcon: Flower2, verdeIcon: Flower2, label: 'Flor' },
    { id: 'droplet', rosaIcon: Droplet, verdeIcon: Droplet, label: 'Gota' },
    { id: 'sparkle', rosaIcon: Sparkles, verdeIcon: Sparkles, label: 'Brillo' },
    { id: 'crown', rosaIcon: Crown, verdeIcon: Crown, label: 'Corona' },
  ];

  return (
    <Modal onClose={onClose} dark={dark}>
      <h3 className="text-2xl mb-1" style={{ fontFamily: '"Cormorant Garamond", serif', fontWeight: 600, fontStyle: 'italic' }}>
        {client ? 'Editar clienta' : 'Nueva clienta VIP'}
      </h3>
      <p className="text-xs opacity-60 mb-5 tracking-wider uppercase">
        {client ? 'Modificá los datos' : 'Completá los datos básicos'}
      </p>

      <div className="space-y-4">
        <Field label="Nombre *" dark={dark}>
          <input type="text" value={name} onChange={e => setName(e.target.value)} placeholder="María González" className="input-style" autoFocus />
        </Field>

        <Field label="Teléfono (WhatsApp)" dark={dark}>
          <input type="tel" value={phone} onChange={e => setPhone(e.target.value)} placeholder="+54 9 351..." className="input-style" />
        </Field>

        <Field label="Marca / Servicio" dark={dark}>
          <div className="grid grid-cols-2 gap-2">
            {(['rosa', 'verde'] as Brand[]).map(b => (
              <button
                key={b}
                onClick={() => setBrand(b)}
                className="py-3 px-3 rounded-2xl text-sm transition-all hover:scale-[1.02]"
                style={{
                  background: brand === b
                    ? themes[b].gradient
                    : (dark ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.6)'),
                  color: brand === b ? themes[b].text : 'inherit',
                  border: `1px solid ${brand === b ? themes[b].primaryDark : 'transparent'}`,
                  fontWeight: brand === b ? 600 : 400,
                }}
              >
                {b === 'rosa' ? '💅 Uñas' : '🌿 Corporal & Facial'}
              </button>
            ))}
          </div>
        </Field>

        <Field label="Template de tarjeta" dark={dark}>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {TEMPLATES.map(t => (
              <button
                key={t.id}
                onClick={() => setTemplate(t.id)}
                className="py-2.5 px-3 rounded-xl text-xs transition-all hover:scale-[1.02] text-left"
                style={{
                  background: template === t.id
                    ? 'linear-gradient(135deg, #D4AF7F 0%, #C98AA0 100%)'
                    : (dark ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.6)'),
                  color: template === t.id ? '#fff' : 'inherit',
                }}
              >
                <div style={{ fontFamily: '"Cormorant Garamond", serif', fontStyle: 'italic', fontSize: '1.05rem', fontWeight: 600 }}>
                  {t.label}
                </div>
                <div className="text-[9px] opacity-70 mt-0.5">{t.description}</div>
              </button>
            ))}
          </div>
        </Field>

        <Field label="Ícono del sello" dark={dark}>
          <div className="grid grid-cols-4 gap-2">
            {stampOptions.map(opt => {
              const Icon = brand === 'rosa' ? opt.rosaIcon : opt.verdeIcon;
              return (
                <button
                  key={opt.id}
                  onClick={() => setStampIcon(opt.id)}
                  className="aspect-square rounded-xl flex items-center justify-center transition-all hover:scale-[1.05]"
                  style={{
                    background: stampIcon === opt.id
                      ? themes[brand].gradient
                      : (dark ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.6)'),
                    border: `1.5px solid ${stampIcon === opt.id ? themes[brand].primaryDark : 'transparent'}`,
                  }}
                  aria-label={opt.label}
                >
                  <Icon size={20} style={{
                    color: stampIcon === opt.id ? themes[brand].primaryDark : 'currentColor',
                    fill: stampIcon === opt.id ? themes[brand].primaryDark : 'transparent',
                    opacity: stampIcon === opt.id ? 1 : 0.55,
                  }} />
                </button>
              );
            })}
          </div>
        </Field>

        <Field label={`Meta de visitas: ${goal}`} dark={dark}>
          <div className="flex gap-2">
            {[5, 6, 8, 10, 12].map(n => (
              <button
                key={n}
                onClick={() => setGoal(n)}
                className="flex-1 py-2.5 rounded-xl text-sm transition-all hover:scale-[1.02]"
                style={{
                  background: goal === n
                    ? 'linear-gradient(135deg, #D4AF7F 0%, #C98AA0 100%)'
                    : (dark ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.6)'),
                  color: goal === n ? '#fff' : 'inherit',
                  fontWeight: goal === n ? 600 : 400,
                }}
              >
                {n}
              </button>
            ))}
          </div>
        </Field>

        <Field label="Notas (opcional)" dark={dark}>
          <textarea value={notes} onChange={e => setNotes(e.target.value)} placeholder="Preferencias, alergias, fecha de cumpleaños…" className="input-style" rows={3} />
        </Field>

        <div className="grid grid-cols-2 gap-2 pt-2">
          <button
            onClick={onClose}
            className="py-3 rounded-2xl transition-all hover:scale-[1.01]"
            style={{
              background: dark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)',
            }}
          >
            Cancelar
          </button>
          <button
            onClick={handleSubmit}
            disabled={!name.trim()}
            className="py-3 rounded-2xl transition-all hover:scale-[1.01] disabled:opacity-50 disabled:cursor-not-allowed"
            style={{
              background: 'linear-gradient(135deg, #D4AF7F 0%, #C98AA0 100%)',
              color: '#fff',
              boxShadow: '0 8px 24px rgba(201,138,160,0.35)',
            }}
          >
            {client ? 'Guardar cambios' : 'Crear tarjeta VIP'}
          </button>
        </div>
      </div>
    </Modal>
  );
};

// ═══════════════════════════════════════════════════════════════════
// PUBLIC CARD VIEW — read-only view of a client's VIP card (for QR/link)
// ═══════════════════════════════════════════════════════════════════
// Reached via /c/{ownerUid}/{clientId} — accessible without login.
// Reads the card and the owner's brand settings directly from Firestore
// using the public read rules. No personal data is exposed beyond what's
// already on the card (name, visits, progress).
//
const PublicCardView: React.FC<{ ownerUid: string; clientId: string }> = ({ ownerUid, clientId }) => {
  const [client, setClient] = useState<Client | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  // Inject Google Fonts
  useEffect(() => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,500;0,600;0,700;1,400;1,600;1,700&family=Outfit:wght@300;400;500;600;700&display=swap';
    document.head.appendChild(link);
    return () => { document.head.removeChild(link); };
  }, []);

  // Load card + settings from Firestore (public read)
  useEffect(() => {
    let alive = true;
    (async () => {
      const [card, raw] = await Promise.all([
        FirebaseAdapter.loadPublicCard(ownerUid, clientId),
        FirebaseAdapter.loadPublicSettings(ownerUid),
      ]);
      if (!alive) return;
      if (!card) {
        setNotFound(true);
        setLoading(false);
        return;
      }
      setClient(card);
      setSettings(raw ? settingsService.migrate(raw) : settingsService.defaults());
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [ownerUid, clientId]);

  // ─── Loading state ───
  if (loading) {
    return (
      <div
        className="min-h-screen w-full flex items-center justify-center"
        style={{
          background: 'radial-gradient(ellipse at top, #FDF6F3 0%, #F5F0EC 50%, #EFEAE4 100%)',
          fontFamily: '"Outfit", system-ui, sans-serif',
        }}
      >
        <div className="text-center">
          <div
            className="text-3xl mb-2"
            style={{
              fontFamily: '"Cormorant Garamond", serif',
              fontStyle: 'italic',
              fontWeight: 700,
              background: 'linear-gradient(135deg, #D4AF7F 0%, #C98AA0 50%, #8FA378 100%)',
              WebkitBackgroundClip: 'text',
              backgroundClip: 'text',
              color: 'transparent',
            }}
          >
            Cargando tu tarjeta…
          </div>
          <div className="text-xs tracking-widest uppercase opacity-50">Un momento</div>
        </div>
      </div>
    );
  }

  // ─── Not found state ───
  if (notFound || !client || !settings) {
    return (
      <div
        className="min-h-screen w-full flex items-center justify-center p-6"
        style={{
          background: 'radial-gradient(ellipse at top, #FDF6F3 0%, #F5F0EC 50%, #EFEAE4 100%)',
          fontFamily: '"Outfit", system-ui, sans-serif',
        }}
      >
        <div className="text-center max-w-md">
          <div
            className="text-3xl mb-2"
            style={{
              fontFamily: '"Cormorant Garamond", serif',
              fontStyle: 'italic',
              fontWeight: 700,
              color: '#C98AA0',
            }}
          >
            Tarjeta no encontrada
          </div>
          <p className="text-sm opacity-70 mt-3">
            El link puede estar incorrecto o la tarjeta ya no existe. Pedile a tu profesional un link actualizado.
          </p>
        </div>
      </div>
    );
  }

  // ─── Card display ───
  const cfg = settings[client.brand];
  const theme = themeService.build(cfg, client.brand);
  const completed = client.visits.length;
  const remaining = clientService.remainingVisits(client);
  const isComplete = clientService.isComplete(client);
  const businessName = cfg.businessName;
  const rewardText = cfg.rewardText;

  return (
    <div
      className="min-h-screen w-full"
      style={{
        background: 'radial-gradient(ellipse at top, #FDF6F3 0%, #F5F0EC 50%, #EFEAE4 100%)',
        fontFamily: '"Outfit", system-ui, sans-serif',
      }}
    >
      <div className="fixed inset-0 pointer-events-none overflow-hidden" style={{ zIndex: 0 }}>
        <div className="absolute -top-40 -right-40 w-96 h-96 rounded-full opacity-30 blur-3xl"
          style={{ background: `radial-gradient(circle, ${theme.primary} 0%, transparent 70%)` }} />
        <div className="absolute -bottom-40 -left-40 w-96 h-96 rounded-full opacity-25 blur-3xl"
          style={{ background: `radial-gradient(circle, ${theme.accent} 0%, transparent 70%)` }} />
      </div>

      <div className="relative z-10 max-w-md mx-auto px-4 py-10 sm:py-16">
        <div className="text-center mb-8">
          {cfg.logo && (
            <div
              className="w-20 h-20 rounded-full overflow-hidden mx-auto mb-3"
              style={{
                border: `1.5px solid ${theme.accent}`,
                background: '#fff',
                boxShadow: `0 8px 24px ${theme.accent}44`,
              }}
            >
              <img src={cfg.logo} alt={businessName} className="w-full h-full object-cover" />
            </div>
          )}
          <div
            className="text-3xl leading-none mb-1"
            style={{
              fontFamily: '"Cormorant Garamond", serif',
              fontStyle: 'italic',
              fontWeight: 700,
              background: theme.foil,
              WebkitBackgroundClip: 'text',
              backgroundClip: 'text',
              color: 'transparent',
            }}
          >
            {businessName}
          </div>
          {settings.cardSubtitle && (
            <div className="text-[10px] tracking-[0.3em] uppercase opacity-60 mt-1">
              {settings.cardSubtitle}
            </div>
          )}
        </div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
        >
          <VIPCard
            client={client}
            businessName={businessName}
            rewardText={rewardText}
            logo={cfg.logo}
            theme={theme}
            customStamps={settings.customStamps || []}
            cardSubtitle={settings.cardSubtitle}
          />
        </motion.div>

        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.3, duration: 0.5 }}
          className="mt-8 text-center"
        >
          {isComplete && !client.rewardClaimed && (
            <div
              className="rounded-3xl p-5"
              style={{
                background: 'rgba(255,255,255,0.7)',
                backdropFilter: 'blur(20px)',
                border: `1px solid ${theme.accent}44`,
              }}
            >
              <div className="text-2xl mb-2" style={{ fontFamily: '"Cormorant Garamond", serif', fontStyle: 'italic', fontWeight: 700, color: theme.primaryDark }}>
                ✨ ¡Premio desbloqueado! ✨
              </div>
              <div className="text-sm opacity-80">{rewardText}</div>
            </div>
          )}

          {isComplete && client.rewardClaimed && (
            <div className="text-sm opacity-70">
              <span style={{ fontFamily: '"Cormorant Garamond", serif', fontStyle: 'italic', fontSize: '1.15rem' }}>
                ¡Gracias por ser parte de {businessName}! 💖
              </span>
            </div>
          )}

          {!isComplete && (
            <div className="text-sm opacity-80">
              <span style={{ fontFamily: '"Cormorant Garamond", serif', fontStyle: 'italic', fontSize: '1.2rem' }}>
                {remaining === 1
                  ? `¡Te falta solo 1 visita para tu premio! 🎁`
                  : `Te faltan ${remaining} visitas para tu premio 🎁`}
              </span>
            </div>
          )}
        </motion.div>

        <div className="mt-12 text-center text-[10px] tracking-[0.25em] uppercase opacity-40">
          Tarjeta VIP digital · {businessName}
        </div>
      </div>
    </div>
  );
};

// ─── Tiny router helper — read URL and decide which view to mount ───
// Looks for /c/{ownerUid}/{clientId} pattern. Everything else falls through
// to the main app (login or dashboard).
function parsePublicCardRoute(): { ownerUid: string; clientId: string } | null {
  if (typeof window === 'undefined') return null;
  const path = window.location.pathname;
  const match = path.match(/^\/c\/([^/]+)\/([^/]+)\/?$/);
  if (!match) return null;
  return { ownerUid: match[1], clientId: match[2] };
}

// ═══════════════════════════════════════════════════════════════════
// ROOT EXPORT — Auth wrapper that decides login vs app
// ═══════════════════════════════════════════════════════════════════
// This is the actual export. It handles the auth lifecycle:
//   - If the URL is a public card route → show PublicCardView (no auth needed)
//   - If no user is logged in → show LoginScreen
//   - If logged in → mount the app with a FirebaseAdapter scoped to their UID
//
export default function GinailsVIP() {
  // Public card route check — runs before anything else.
  const publicRoute = useMemo(() => parsePublicCardRoute(), []);

  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);

  // Listen to auth state changes (login, logout, session restore on reload)
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setAuthLoading(false);
    });
    return () => unsubscribe();
  }, []);

  // Build the Firebase-backed config — only when we have a user
  const firebaseConfig = useMemo<VIPModuleConfig | undefined>(() => {
    if (!user) return undefined;
    return {
      storageAdapter: new FirebaseAdapter(user.uid),
      tenantId: user.uid,
    };
  }, [user]);

  // If this is a public card route, render the viewer regardless of auth state
  if (publicRoute) {
    return <PublicCardView ownerUid={publicRoute.ownerUid} clientId={publicRoute.clientId} />;
  }

  // ── Loading state ──
  if (authLoading) {
    return (
      <div
        className="min-h-screen w-full flex items-center justify-center"
        style={{
          background: 'radial-gradient(ellipse at top, #FDF6F3 0%, #F5F0EC 50%, #EFEAE4 100%)',
          fontFamily: '"Outfit", system-ui, sans-serif',
        }}
      >
        <div className="text-center">
          <div
            className="text-3xl mb-2"
            style={{
              fontFamily: '"Cormorant Garamond", serif',
              fontStyle: 'italic',
              fontWeight: 700,
              background: 'linear-gradient(135deg, #D4AF7F 0%, #C98AA0 50%, #8FA378 100%)',
              WebkitBackgroundClip: 'text',
              backgroundClip: 'text',
              color: 'transparent',
            }}
          >
            Ginails VIP
          </div>
          <div className="text-xs tracking-widest uppercase opacity-50">Cargando…</div>
        </div>
      </div>
    );
  }

  // ── Not logged in → show login ──
  if (!user) {
    return <LoginScreen />;
  }

  // ── Logged in → mount the app with Firebase persistence ──
  return (
    <>
      <GinailsVIPApp config={firebaseConfig} />
      {/* Tiny logout button in the corner — non-intrusive */}
      <button
        onClick={() => signOut(auth)}
        className="fixed bottom-3 left-3 z-50 text-[9px] tracking-widest uppercase opacity-30 hover:opacity-80 transition-opacity px-2 py-1 rounded"
        style={{
          background: 'rgba(255,255,255,0.5)',
          backdropFilter: 'blur(8px)',
        }}
      >
        Cerrar sesión
      </button>
    </>
  );
}