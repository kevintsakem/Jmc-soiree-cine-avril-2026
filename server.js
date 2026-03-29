// =============================================
// SERVEUR JMC SOIRÉE CINÉMA 2026
// Node.js + Express + PostgreSQL (Supabase) + Export Excel
// =============================================
//
// VARIABLES D'ENVIRONNEMENT REQUISES :
//   DATABASE_URL  — Connection string Supabase
//                   ex: postgresql://postgres:[password]@db.[ref].supabase.co:5432/postgres
//
// DÉMARRAGE LOCAL :
//   Crée un fichier .env avec DATABASE_URL=...
//   npm install && npm start
//
// DÉPLOIEMENT :
//   Render.com → connecte le repo GitHub, ajoute DATABASE_URL dans Environment
// =============================================

const express  = require('express');
const { Pool } = require('pg');
const XLSX     = require('xlsx');
const path     = require('path');
const cors     = require('cors');

const app  = express();
const PORT = process.env.PORT || 3000;

// =============================================
// CONNEXION POSTGRESQL (Supabase)
// =============================================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }  // requis pour Supabase / Render
});

// Crée la table si elle n'existe pas encore
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS inscriptions (
      id          SERIAL PRIMARY KEY,
      timestamp   TEXT,
      full_name   TEXT NOT NULL,
      gender      TEXT,
      phone       TEXT,
      church      TEXT,
      email       TEXT DEFAULT 'N/A',
      ticket_id   TEXT UNIQUE NOT NULL,
      scan_status TEXT DEFAULT 'Non scanné',
      scan_time   TEXT DEFAULT ''
    )
  `);
  console.log('✅ Base de données prête');
}

// =============================================
// MIDDLEWARES
// =============================================
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// =============================================
// API — compatible avec l'ancien Google Apps Script
// Tous les appels passent par GET /api?action=...
// =============================================
app.get('/api', async (req, res) => {
  const action = (req.query.action || '').toLowerCase();

  try {
    if (action === 'register') {
      return await handleRegister(req.query, res);
    } else if (action === 'scan') {
      return await handleScan(req.query.ticket_id, res);
    } else if (action === 'list') {
      return await handleList(res);
    } else if (action === 'export') {
      return await handleExport(res);
    } else {
      return res.json({ status: 'ok', message: 'JMC Soirée Cinéma API v3. Actions: register, scan, list, export' });
    }
  } catch (err) {
    console.error('API error:', err);
    return res.json({ status: 'error', message: err.toString() });
  }
});

// =============================================
// REGISTER — Nouvelle inscription
// =============================================
async function handleRegister(params, res) {
  const timestamp = params.timestamp ||
    new Date().toLocaleString('fr-FR', { timeZone: 'Africa/Douala' });

  try {
    await pool.query(
      `INSERT INTO inscriptions (timestamp, full_name, gender, phone, church, email, ticket_id, scan_status, scan_time)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'Non scanné','')`,
      [timestamp, params.full_name || '', params.gender || '', params.phone || '',
       params.church || '', params.email || 'N/A', params.ticket_id || '']
    );
    return res.json({ status: 'success', message: 'Inscription enregistrée', ticket_id: params.ticket_id });
  } catch (err) {
    if (err.code === '23505') { // unique_violation
      return res.json({ status: 'error', message: 'Ce ticket ID existe déjà.' });
    }
    throw err;
  }
}

// =============================================
// SCAN — Vérifier et valider un ticket
// =============================================
async function handleScan(ticketId, res) {
  if (!ticketId) {
    return res.json({ status: 'error', message: 'ticket_id manquant' });
  }

  const { rows } = await pool.query(
    'SELECT * FROM inscriptions WHERE ticket_id = $1', [ticketId]
  );

  if (rows.length === 0) {
    return res.json({ status: 'not_found', message: 'Aucun inscrit trouvé avec ce ticket ID.' });
  }

  const row = rows[0];
  const guestData = {
    full_name:   row.full_name,
    gender:      row.gender,
    phone:       row.phone,
    church:      row.church,
    email:       row.email,
    ticket_id:   row.ticket_id,
    scan_status: row.scan_status,
    scanned_at:  row.scan_time || null
  };

  if (row.scan_status === 'Scanné') {
    return res.json({ status: 'already_scanned', message: 'Ce ticket a déjà été scanné.', data: guestData });
  }

  const scanTime = new Date().toLocaleString('fr-FR', { timeZone: 'Africa/Douala' });
  await pool.query(
    'UPDATE inscriptions SET scan_status=$1, scan_time=$2 WHERE ticket_id=$3',
    ['Scanné', scanTime, ticketId]
  );

  guestData.scan_status = 'Scanné';
  guestData.scanned_at  = scanTime;

  return res.json({ status: 'success', message: 'Ticket scanné avec succès !', data: guestData });
}

// =============================================
// LIST — Retourner tous les inscrits
// =============================================
async function handleList(res) {
  const { rows } = await pool.query('SELECT * FROM inscriptions ORDER BY id ASC');
  const guests = rows.map(row => ({
    timestamp:   row.timestamp,
    full_name:   row.full_name,
    gender:      row.gender,
    phone:       row.phone,
    church:      row.church,
    email:       row.email,
    ticket_id:   row.ticket_id,
    scan_status: row.scan_status || 'Non scanné',
    scanned_at:  row.scan_time || null
  }));
  return res.json({ status: 'success', data: guests });
}

// =============================================
// EXPORT — Télécharger le fichier Excel
// =============================================
async function handleExport(res) {
  const { rows } = await pool.query('SELECT * FROM inscriptions ORDER BY id ASC');

  const wsData = [
    ['Timestamp', 'Nom Complet', 'Sexe', 'Téléphone', 'Église', 'Email', 'Ticket ID', 'Statut Scan', 'Heure Scan'],
    ...rows.map(row => [
      row.timestamp, row.full_name, row.gender, row.phone,
      row.church, row.email, row.ticket_id, row.scan_status, row.scan_time
    ])
  ];

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(wsData);
  ws['!cols'] = [
    { wch: 20 }, { wch: 28 }, { wch: 10 }, { wch: 16 },
    { wch: 22 }, { wch: 26 }, { wch: 20 }, { wch: 14 }, { wch: 20 }
  ];
  XLSX.utils.book_append_sheet(wb, ws, 'Inscriptions');

  const buffer   = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const filename = `inscriptions-JMC-${new Date().toISOString().split('T')[0]}.xlsx`;

  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buffer);
}

// =============================================
// DÉMARRAGE
// =============================================
initDB().then(() => {
  app.listen(PORT, () => {
    console.log('✅ Serveur JMC Soirée Cinéma démarré');
    console.log(`   Local   : http://localhost:${PORT}`);
  });
}).catch(err => {
  console.error('❌ Erreur connexion base de données:', err.message);
  process.exit(1);
});
