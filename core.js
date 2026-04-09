
// ============================================================
// RayWatch Platform — Core Schema, Engine & Mock API
// ============================================================

// ── Schema definitions ──────────────────────────────────────

export const SCHEMA = {
  sighting: {
    id:            'uuid',
    submitted_at:  'timestamp',
    status:        'enum(pending|approved|rejected)',
    // Location — exact coords stored privately, never exposed publicly
    lat:           'float',
    lng:           'float',
    accuracy_m:    'int',          // GPS accuracy radius
    // Observation
    count:         'int',          // ray count (1–500+)
    behavior:      'enum(feeding|transiting|resting|unknown)',
    depth_m:       'float|null',
    water_temp_c:  'float|null',
    // Submitter
    submitter_name:  'string|null',
    submitter_email: 'string|null',
    submitter_type:  'enum(public|researcher|fisherman)',
    photo_url:       'string|null',
    notes:           'string|null',
    // Admin
    reviewed_by:   'string|null',
    reviewed_at:   'timestamp|null',
    reject_reason: 'string|null',
    // Generalized output (computed on approval)
    cell_lat:      'float',   // grid-snapped centroid
    cell_lng:      'float',
    cell_size_deg: 'float',
  },

  telemetry_summary: {
    id:           'uuid',
    uploaded_at:  'timestamp',
    researcher:   'string',
    season:       'string',      // e.g. "Spring 2024"
    region:       'string',
    // Aggregated only — no individual tag tracks exposed
    tag_count:    'int',
    track_count:  'int',
    // Spatial summary as grid cells with density
    cells: [{
      cell_lat: 'float', cell_lng: 'float',
      density: 'float',  // 0–1 normalized
    }],
    notes: 'string|null',
  },

  risk_zone: {
    cell_lat:      'float',
    cell_lng:      'float',
    cell_size_deg: 'float',
    kde_intensity: 'float',   // 0–1
    fishing_weight:'float',   // 0–1 from fishery layer
    risk_tier:     'enum(low|medium|high)',
    sighting_count:'int',     // aggregate, min-k anonymized
    season:        'string',
    updated_at:    'timestamp',
  },
};

// ── Generalization Engine ────────────────────────────────────

export const GeneralizationEngine = {
  CELL_SIZE: 0.15,       // degrees (~15km)
  MIN_K: 3,              // k-anonymity minimum group size
  KDE_BANDWIDTH: 2,      // cells
  FISHING_LAYER: null,   // injected externally

  /**
   * Snap exact coordinates to grid cell centroid
   */
  snapToGrid(lat, lng, cellSize = this.CELL_SIZE) {
    const cellLat = Math.floor(lat / cellSize) * cellSize + cellSize / 2;
    const cellLng = Math.floor(lng / cellSize) * cellSize + cellSize / 2;
    return { cell_lat: +cellLat.toFixed(5), cell_lng: +cellLng.toFixed(5), cell_size_deg: cellSize };
  },

  /**
   * Aggregate approved sightings into grid cells with k-anonymity
   * Returns only cells with count >= MIN_K
   */
  aggregateCells(sightings, cellSize = this.CELL_SIZE) {
    const cells = {};
    sightings.forEach(s => {
      const { cell_lat, cell_lng } = this.snapToGrid(s.lat, s.lng, cellSize);
      const key = `${cell_lat},${cell_lng}`;
      if (!cells[key]) cells[key] = { cell_lat, cell_lng, count: 0, ray_count: 0, season_counts: {} };
      cells[key].count++;
      cells[key].ray_count += s.count || 1;
      const season = this.getSeason(s.submitted_at);
      cells[key].season_counts[season] = (cells[key].season_counts[season] || 0) + 1;
    });
    // Apply k-anonymity: suppress cells with fewer than MIN_K sightings
    return Object.values(cells).filter(c => c.count >= this.MIN_K);
  },

  /**
   * Kernel Density Estimation over grid cells
   * Returns cells with normalized intensity scores
   */
  computeKDE(cells, bandwidth = this.KDE_BANDWIDTH, cellSize = this.CELL_SIZE) {
    const result = {};
    cells.forEach(source => {
      cells.forEach(target => {
        const dLat = (source.cell_lat - target.cell_lat) / cellSize;
        const dLng = (source.cell_lng - target.cell_lng) / cellSize;
        const d2 = dLat * dLat + dLng * dLng;
        if (d2 > bandwidth * bandwidth * 4) return;
        const weight = source.count * Math.exp(-0.5 * d2 / (bandwidth * bandwidth));
        const key = `${target.cell_lat},${target.cell_lng}`;
        result[key] = (result[key] || 0) + weight;
      });
    });
    const maxVal = Math.max(...Object.values(result), 1);
    return cells.map(c => ({
      ...c,
      kde_intensity: +((result[`${c.cell_lat},${c.cell_lng}`] || 0) / maxVal).toFixed(3),
    }));
  },

  /**
   * Score bycatch risk per cell
   * fishingPressure: 0–1 regional weight (from fishery layer or slider)
   */
  scoreRisk(kdeCells, getFishingWeight) {
    return kdeCells.map(c => {
      const fw = getFishingWeight ? getFishingWeight(c.cell_lat, c.cell_lng) : 0.5;
      const score = c.kde_intensity * fw;
      return {
        ...c,
        fishing_weight: +fw.toFixed(3),
        risk_score: +score.toFixed(3),
        risk_tier: score > 0.35 ? 'high' : score > 0.12 ? 'medium' : 'low',
      };
    });
  },

  getSeason(ts) {
    const m = new Date(ts).getMonth();
    if (m >= 2 && m <= 4) return 'Spring';
    if (m >= 5 && m <= 7) return 'Summer';
    if (m >= 8 && m <= 10) return 'Fall';
    return 'Winter';
  },

  /**
   * Full pipeline: raw sightings → public risk zones
   */
  process(sightings, getFishingWeight, cellSize = this.CELL_SIZE) {
    const cells = this.aggregateCells(sightings, cellSize);
    const kde   = this.computeKDE(cells, this.KDE_BANDWIDTH, cellSize);
    return this.scoreRisk(kde, getFishingWeight);
  },
};

// ── Mock Data Store ──────────────────────────────────────────

function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

function rng(seed) {
  let s = seed;
  return () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
}

// Chesapeake Bay / Mid-Atlantic region seed data
const SEED_SIGHTINGS = (() => {
  const r = rng(42);
  const clusters = [
    { lat: 36.85, lng: -75.98, name: 'Virginia Beach shelf' },
    { lat: 37.20, lng: -76.10, name: 'Chesapeake mouth' },
    { lat: 36.60, lng: -75.80, name: 'Outer Banks north' },
    { lat: 37.80, lng: -76.30, name: 'Chesapeake mid-bay' },
    { lat: 36.40, lng: -75.70, name: 'Pamlico Sound' },
  ];
  const behaviors = ['feeding', 'transiting', 'resting', 'unknown'];
  const statuses = ['approved', 'approved', 'approved', 'approved', 'pending', 'pending', 'rejected'];
  const now = Date.now();
  const sightings = [];
  for (let i = 0; i < 80; i++) {
    const c = clusters[Math.floor(r() * clusters.length)];
    const lat = c.lat + (r() - 0.5) * 0.6;
    const lng = c.lng + (r() - 0.5) * 0.5;
    const daysAgo = Math.floor(r() * 180);
    const status = statuses[Math.floor(r() * statuses.length)];
    sightings.push({
      id: uuid(),
      submitted_at: new Date(now - daysAgo * 86400000).toISOString(),
      status,
      lat: +lat.toFixed(5),
      lng: +lng.toFixed(5),
      accuracy_m: Math.round(5 + r() * 30),
      count: Math.round(1 + r() * r() * 120),
      behavior: behaviors[Math.floor(r() * behaviors.length)],
      depth_m: r() > 0.4 ? +(2 + r() * 18).toFixed(1) : null,
      water_temp_c: r() > 0.3 ? +(14 + r() * 14).toFixed(1) : null,
      submitter_name: r() > 0.5 ? ['J. Martinez', 'K. Oduya', 'T. Brennan', 'S. Park', 'A. Williams'][Math.floor(r() * 5)] : null,
      submitter_email: null,
      submitter_type: ['public', 'public', 'public', 'fisherman', 'researcher'][Math.floor(r() * 5)],
      photo_url: r() > 0.6 ? `https://picsum.photos/seed/${i}/400/300` : null,
      notes: r() > 0.7 ? ['Large aggregation near surface', 'Moving SW', 'Feeding on bivalves', 'Schools visible from pier'][Math.floor(r() * 4)] : null,
      reviewed_by: status !== 'pending' ? 'admin@raywatch.org' : null,
      reviewed_at: status !== 'pending' ? new Date(now - (daysAgo - 1) * 86400000).toISOString() : null,
      reject_reason: status === 'rejected' ? 'Coordinates outside survey region' : null,
      ...GeneralizationEngine.snapToGrid(lat, lng),
    });
  }
  return sightings;
})();

// ── Mock API ─────────────────────────────────────────────────

export const API = {
  _store: [...SEED_SIGHTINGS],

  delay: (ms = 200) => new Promise(r => setTimeout(r, ms + Math.random() * 150)),

  async submitSighting(data) {
    await this.delay(400);
    const id = uuid();
    const sighting = {
      id,
      submitted_at: new Date().toISOString(),
      status: 'pending',
      reviewed_by: null,
      reviewed_at: null,
      reject_reason: null,
      ...data,
      ...GeneralizationEngine.snapToGrid(data.lat, data.lng),
    };
    this._store.push(sighting);
    return { ok: true, id, sighting };
  },

  async getPending() {
    await this.delay();
    return this._store.filter(s => s.status === 'pending')
      .sort((a, b) => new Date(b.submitted_at) - new Date(a.submitted_at));
  },

  async getAll() {
    await this.delay();
    return [...this._store].sort((a, b) => new Date(b.submitted_at) - new Date(a.submitted_at));
  },

  async reviewSighting(id, action, reason = null) {
    await this.delay(300);
    const s = this._store.find(s => s.id === id);
    if (!s) return { ok: false, error: 'Not found' };
    s.status = action === 'approve' ? 'approved' : 'rejected';
    s.reviewed_by = 'admin@raywatch.org';
    s.reviewed_at = new Date().toISOString();
    s.reject_reason = reason;
    return { ok: true, sighting: s };
  },

  async getPublicRiskZones(season = null) {
    await this.delay();
    let approved = this._store.filter(s => s.status === 'approved');
    if (season) approved = approved.filter(s => GeneralizationEngine.getSeason(s.submitted_at) === season);
    // Simulate fishing pressure by longitude (coastal = higher)
    const getFishingWeight = (lat, lng) => {
      const coastalProx = Math.max(0, 1 - Math.abs(lng + 75.9) * 3);
      return Math.min(1, 0.2 + coastalProx * 0.8);
    };
    return GeneralizationEngine.process(approved, getFishingWeight);
  },

  async getStats() {
    await this.delay(100);
    const all = this._store;
    return {
      total: all.length,
      pending: all.filter(s => s.status === 'pending').length,
      approved: all.filter(s => s.status === 'approved').length,
      rejected: all.filter(s => s.status === 'rejected').length,
      total_rays: all.filter(s => s.status === 'approved').reduce((n, s) => n + (s.count || 1), 0),
    };
  },
};

export default { SCHEMA, GeneralizationEngine, API };
