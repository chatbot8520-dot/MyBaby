import express, { Request, Response, NextFunction } from 'express';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { createServer as createViteServer } from 'vite';

const DB_DIR = path.join(process.cwd(), 'data');
const DB_FILE = path.join(DB_DIR, 'db.json');

interface DatabaseSchema {
  mothers: Array<{
    id: string;
    name: string;
    email: string;
    password: string;
    whatsapp: string;
    createdAt: string;
  }>;
  sessions: Record<string, { motherId: string; createdAt: string }>;
  babies: Array<{
    id: string;
    motherId: string;
    name: string;
    nickname: string;
    birthDate: string;
    isEstimatedBirthDate?: boolean;
    birthTime?: string;
    gender: 'menino' | 'menina' | 'surpresa';
    weightKg?: number;
    heightCm?: number;
    bloodType?: string;
    zodiacSign: string;
    hospitalCity?: string;
    birthStory?: string;
    traits: string[];
    photoUrl: string;
    ultrasoundPhotoUrl?: string;
    pixKey: string;
    pixKeyType: 'cpf' | 'email' | 'telefone' | 'aleatoria';
    pixHolderName: string;
    themeColor: string;
    createdAt: string;
  }>;
  gifts: Array<{
    id: string;
    babyId: string;
    title: string;
    category: string;
    estimatedPrice?: number;
    status: 'available' | 'reserved' | 'delivered';
    reservedBy?: {
      name: string;
      phone: string;
      note?: string;
      reservedAt: string;
    };
    notes?: string;
    priority?: 'alta' | 'media' | 'baixa';
  }>;
  milestones: Array<{
    id: string;
    babyId: string;
    title: string;
    ageLabel: string;
    date: string;
    description: string;
    photoUrl?: string;
    emoji?: string;
  }>;
  messages: Array<{
    id: string;
    babyId: string;
    authorName: string;
    relationship: string;
    message: string;
    createdAt: string;
    likes: number;
  }>;
}

// Initial clean database schema (empty for first real mother registration)
function getInitialDb(): DatabaseSchema {
  return {
    mothers: [],
    sessions: {},
    babies: [],
    gifts: [],
    milestones: [],
    messages: [],
  };
}

function readDb(): DatabaseSchema {
  try {
    if (!fs.existsSync(DB_DIR)) {
      fs.mkdirSync(DB_DIR, { recursive: true });
    }
    if (!fs.existsSync(DB_FILE)) {
      const initial = getInitialDb();
      fs.writeFileSync(DB_FILE, JSON.stringify(initial, null, 2), 'utf-8');
      return initial;
    }
    const data = fs.readFileSync(DB_FILE, 'utf-8');
    return JSON.parse(data);
  } catch (err) {
    console.error('Error reading db.json, returning fallback:', err);
    return getInitialDb();
  }
}

function writeDb(db: DatabaseSchema) {
  try {
    if (!fs.existsSync(DB_DIR)) {
      fs.mkdirSync(DB_DIR, { recursive: true });
    }
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf-8');
  } catch (err) {
    console.error('Error writing to db.json:', err);
  }
}

function generateNumericBabyId(existingIds: string[]): string {
  let id = '';
  do {
    // 7 digit numeric string like 5485685
    const num = Math.floor(1000000 + Math.random() * 9000000);
    id = num.toString();
  } while (existingIds.includes(id));
  return id;
}

// Authentication middleware
interface AuthenticatedRequest extends Request {
  currentMother?: {
    id: string;
    name: string;
    email: string;
    whatsapp: string;
  };
}

function authMiddleware(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Sessão não autorizada. Faça login.' });
    return;
  }

  const token = authHeader.slice(7).trim();
  const db = readDb();
  const session = db.sessions[token];

  if (!session) {
    res.status(401).json({ error: 'Sessão expirada ou inválida.' });
    return;
  }

  const mother = db.mothers.find((m) => m.id === session.motherId);
  if (!mother) {
    res.status(401).json({ error: 'Mãe não encontrada.' });
    return;
  }

  req.currentMother = {
    id: mother.id,
    name: mother.name,
    email: mother.email,
    whatsapp: mother.whatsapp,
  };
  next();
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // Healthcheck
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', serverTime: new Date().toISOString() });
  });

  // ==========================================
  // AUTHENTICATION ROUTES (Mother Signup & Login)
  // ==========================================

  // Register mother
  app.post('/api/auth/register', (req, res) => {
    const { name, email, password, whatsapp } = req.body;

    if (!name || !email || !password || !whatsapp) {
      return res.status(400).json({ error: 'Preencha todos os campos obrigatórios.' });
    }

    const cleanEmail = email.trim().toLowerCase();
    const db = readDb();

    const existing = db.mothers.find((m) => m.email.toLowerCase() === cleanEmail);
    if (existing) {
      return res.status(400).json({ error: 'Já existe uma conta com este e-mail. Faça login.' });
    }

    const motherId = 'mother-' + Date.now() + '-' + Math.random().toString(36).substring(2, 6);
    const newMother = {
      id: motherId,
      name: name.trim(),
      email: cleanEmail,
      password: password.trim(),
      whatsapp: whatsapp.trim(),
      createdAt: new Date().toISOString(),
    };

    db.mothers.push(newMother);

    // Create session token
    const token = crypto.randomBytes(32).toString('hex');
    db.sessions[token] = {
      motherId: newMother.id,
      createdAt: new Date().toISOString(),
    };

    writeDb(db);

    return res.json({
      token,
      mother: {
        id: newMother.id,
        name: newMother.name,
        email: newMother.email,
        whatsapp: newMother.whatsapp,
      },
    });
  });

  // Register full: Atomic creation of Mother + Baby + Elected Gift Checklist
  app.post('/api/auth/register-full', (req, res) => {
    try {
      const { mother, baby, gifts } = req.body;

      if (!baby || !baby.name || !baby.name.trim()) {
        return res.status(400).json({ error: 'O nome do bebê é obrigatório.' });
      }

      const db = readDb();
      let activeMotherId = '';
      let token = '';

      // Check if bearer token already gives us an active session
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith('Bearer ')) {
        const existingToken = authHeader.slice(7).trim();
        if (db.sessions[existingToken]) {
          activeMotherId = db.sessions[existingToken].motherId;
          token = existingToken;
        }
      }

      // If mother information is supplied in payload, handle registration / authentication
      if (mother && mother.email && mother.email.trim()) {
        const motherName = (mother.name || '').trim();
        const cleanEmail = mother.email.trim().toLowerCase();
        const motherPassword = (mother.password || '').trim();
        const motherWhatsapp = (mother.whatsapp || '').trim();

        const existingMother = db.mothers.find((m) => m.email.toLowerCase() === cleanEmail);

        if (existingMother) {
          // If password matches or user was already logged in as this mother, reuse mother
          if (!motherPassword || existingMother.password === motherPassword) {
            activeMotherId = existingMother.id;
          } else {
            return res.status(400).json({
              error: 'Este e-mail já está cadastrado. Se esta é sua conta, digite a senha correta ou faça login.',
            });
          }
        } else {
          // New mother registration
          if (!motherName || !motherPassword) {
            return res.status(400).json({ error: 'Nome, e-mail e senha da mãe são obrigatórios para o cadastro.' });
          }

          activeMotherId = 'mother-' + Date.now() + '-' + Math.random().toString(36).substring(2, 6);
          const newMother = {
            id: activeMotherId,
            name: motherName,
            email: cleanEmail,
            password: motherPassword,
            whatsapp: motherWhatsapp,
            createdAt: new Date().toISOString(),
          };
          db.mothers.push(newMother);
        }

        // Generate / renew session token
        token = crypto.randomBytes(32).toString('hex');
        db.sessions[token] = {
          motherId: activeMotherId,
          createdAt: new Date().toISOString(),
        };
      }

      // If still no active mother
      if (!activeMotherId) {
        return res.status(400).json({
          error: 'Por favor, informe os dados da mãe (nome, e-mail e senha) para concluir o cadastro.',
        });
      }

      const currentMotherRecord = db.mothers.find((m) => m.id === activeMotherId)!;

      // Validate baby
      if (!baby.name || !baby.name.trim()) {
        return res.status(400).json({ error: 'O nome do bebê é obrigatório.' });
      }

      const existingIds = db.babies.map((b) => b.id);
      const newBabyId = generateNumericBabyId(existingIds);

      const parsedWeight = baby.weightKg ? parseFloat(baby.weightKg) : undefined;
      const parsedHeight = baby.heightCm ? parseFloat(baby.heightCm) : undefined;

      const newBaby = {
        id: newBabyId,
        motherId: activeMotherId,
        name: baby.name.trim(),
        nickname: (baby.nickname || baby.name.split(' ')[0]).trim(),
        birthDate: (baby.birthDate || new Date().toISOString().split('T')[0]).trim(),
        isEstimatedBirthDate: baby.isEstimatedBirthDate ?? true,
        birthTime: baby.birthTime ? baby.birthTime.trim() : '09:00',
        gender: baby.gender || 'surpresa',
        weightKg: isNaN(parsedWeight as number) ? undefined : parsedWeight,
        heightCm: isNaN(parsedHeight as number) ? undefined : parsedHeight,
        bloodType: baby.bloodType ? baby.bloodType.trim() : undefined,
        zodiacSign: (baby.zodiacSign || 'Bebê Querido').trim(),
        hospitalCity: (baby.hospitalCity || '').trim(),
        birthStory: (baby.birthStory || '').trim(),
        traits: Array.isArray(baby.traits) && baby.traits.length > 0 ? baby.traits : ['Amor da família'],
        photoUrl:
          baby.photoUrl ||
          'https://images.unsplash.com/photo-1519689680058-324335c77eba?auto=format&fit=crop&w=1000&q=80',
        ultrasoundPhotoUrl: baby.ultrasoundPhotoUrl || '',
        pixKey: (baby.pixKey || currentMotherRecord.email).trim(),
        pixKeyType: baby.pixKeyType || 'email',
        pixHolderName: (baby.pixHolderName || currentMotherRecord.name).trim(),
        themeColor: baby.themeColor || 'manteiga',
        createdAt: new Date().toISOString(),
      };

      db.babies.push(newBaby);

      // Create gifts from the elected checklist
      const giftsToInsert: any[] = [];
      if (Array.isArray(gifts) && gifts.length > 0) {
        gifts.forEach((g: any, index: number) => {
          if (g && g.title) {
            giftsToInsert.push({
              id: 'g-' + Date.now() + '-' + (index + 1),
              babyId: newBabyId,
              title: g.title.trim(),
              category: g.category || 'Higiene & Fraldas',
              estimatedPrice: g.estimatedPrice ? parseFloat(g.estimatedPrice) : undefined,
              status: 'available',
              priority: g.priority || 'alta',
              notes: g.notes ? g.notes.trim() : undefined,
            });
          }
        });
      } else {
        // Default essential gifts if none elected
        giftsToInsert.push(
          {
            id: 'g-' + Date.now() + '-1',
            babyId: newBabyId,
            title: 'Pacote de Fraldas RN / P Confort',
            category: 'Higiene & Fraldas',
            estimatedPrice: 79.9,
            status: 'available',
            priority: 'alta',
            notes: 'Marca de preferência da mamãe',
          },
          {
            id: 'g-' + Date.now() + '-2',
            babyId: newBabyId,
            title: 'Kit Toalhas de Banho com Capuz 100% Algodão',
            category: 'Higiene & Fraldas',
            estimatedPrice: 85.0,
            status: 'available',
            priority: 'media',
          }
        );
      }

      db.gifts.push(...giftsToInsert);

      // Create initial milestones
      const milestonesToInsert = [
        {
          id: 'm-' + Date.now() + '-1',
          babyId: newBabyId,
          title: newBaby.isEstimatedBirthDate ? 'Previsão do Nascimento (DPP)' : 'Dia do Nascimento',
          ageLabel: newBaby.isEstimatedBirthDate ? 'Chegando em Breve' : '0 Dias',
          date: newBaby.birthDate,
          description: newBaby.isEstimatedBirthDate
            ? 'Corações ansiosos aguardando a chegada do nosso maior amor.'
            : `Chegada tão esperada do nosso anjinho.`,
          photoUrl: newBaby.photoUrl,
          emoji: '👶',
        },
        {
          id: 'm-' + Date.now() + '-2',
          babyId: newBabyId,
          title: 'Primeiro Ultrassom',
          ageLabel: 'Lembrança',
          date: newBaby.birthDate,
          description: 'A emoção inesquecível de ouvir as batidas do seu coração pela primeira vez.',
          photoUrl: newBaby.ultrasoundPhotoUrl || newBaby.photoUrl,
          emoji: '✨',
        },
      ];
      db.milestones.push(...milestonesToInsert);

      writeDb(db);

      return res.json({
        token,
        mother: {
          id: currentMotherRecord.id,
          name: currentMotherRecord.name,
          email: currentMotherRecord.email,
          whatsapp: currentMotherRecord.whatsapp,
        },
        baby: newBaby,
        giftsCount: giftsToInsert.length,
      });
    } catch (err: any) {
      console.error('Error in register-full:', err);
      return res.status(500).json({ error: 'Falha ao salvar cadastro: ' + (err?.message || 'Erro interno') });
    }
  });

  // Login mother
  app.post('/api/auth/login', (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Informe e-mail e senha.' });
    }

    const cleanEmail = email.trim().toLowerCase();
    const cleanPassword = password.trim();
    const db = readDb();

    const mother = db.mothers.find(
      (m) => m.email.toLowerCase() === cleanEmail && m.password === cleanPassword
    );

    if (!mother) {
      return res.status(401).json({ error: 'E-mail ou senha incorretos.' });
    }

    // Create session token
    const token = crypto.randomBytes(32).toString('hex');
    db.sessions[token] = {
      motherId: mother.id,
      createdAt: new Date().toISOString(),
    };
    writeDb(db);

    return res.json({
      token,
      mother: {
        id: mother.id,
        name: mother.name,
        email: mother.email,
        whatsapp: mother.whatsapp,
      },
    });
  });

  // Current logged in mother
  app.get('/api/auth/me', authMiddleware, (req: AuthenticatedRequest, res) => {
    res.json({ mother: req.currentMother });
  });

  // Logout
  app.post('/api/auth/logout', (req, res) => {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.slice(7).trim();
      const db = readDb();
      delete db.sessions[token];
      writeDb(db);
    }
    res.json({ success: true });
  });

  // ==========================================
  // MOTHER DASHBOARD ROUTES (Private & Isolated)
  // Each mother can ONLY view and edit HER OWN babies
  // ==========================================

  // Get all babies belonging to the authenticated mother
  app.get('/api/mothers/me/babies', authMiddleware, (req: AuthenticatedRequest, res) => {
    const db = readDb();
    const motherId = req.currentMother!.id;
    const myBabies = db.babies.filter((b) => b.motherId === motherId);
    res.json({ babies: myBabies });
  });

  // Create a new baby under this mother's account
  app.post('/api/mothers/me/babies', authMiddleware, (req: AuthenticatedRequest, res) => {
    const motherId = req.currentMother!.id;
    const {
      name,
      nickname,
      birthDate,
      birthTime,
      gender,
      weightKg,
      heightCm,
      bloodType,
      zodiacSign,
      hospitalCity,
      birthStory,
      traits,
      photoUrl,
      ultrasoundPhotoUrl,
      pixKey,
      pixKeyType,
      pixHolderName,
      themeColor,
    } = req.body;

    if (!name || !birthDate) {
      return res.status(400).json({ error: 'Nome e data de nascimento são obrigatórios.' });
    }

    const db = readDb();
    const existingIds = db.babies.map((b) => b.id);
    const newBabyId = generateNumericBabyId(existingIds);

    const newBaby = {
      id: newBabyId,
      motherId,
      name: name.trim(),
      nickname: (nickname || name.split(' ')[0]).trim(),
      birthDate: birthDate.trim(),
      birthTime: (birthTime || '09:00').trim(),
      gender: gender || 'surpresa',
      weightKg: parseFloat(weightKg) || 3.3,
      heightCm: parseFloat(heightCm) || 49.0,
      bloodType: (bloodType || 'O+').trim(),
      zodiacSign: (zodiacSign || 'Bebê Amado').trim(),
      hospitalCity: (hospitalCity || 'Maternidade').trim(),
      birthStory: (birthStory || 'O nascimento de um novo amor na nossa família.').trim(),
      traits: Array.isArray(traits) && traits.length > 0 ? traits : ['Amor da família'],
      photoUrl:
        photoUrl ||
        'https://images.unsplash.com/photo-1519689680058-324335c77eba?auto=format&fit=crop&w=1000&q=80',
      ultrasoundPhotoUrl:
        ultrasoundPhotoUrl ||
        'https://images.unsplash.com/photo-1555252333-9f8e92e65df9?auto=format&fit=crop&w=800&q=80',
      pixKey: (pixKey || req.currentMother!.email).trim(),
      pixKeyType: pixKeyType || 'email',
      pixHolderName: (pixHolderName || req.currentMother!.name).trim(),
      themeColor: themeColor || 'manteiga',
      createdAt: new Date().toISOString(),
    };

    db.babies.push(newBaby);

    // Add default initial milestones
    const defaultMilestones = [
      {
        id: 'm-' + Date.now() + '-1',
        babyId: newBabyId,
        title: 'Dia do Nascimento',
        ageLabel: '0 Dias',
        date: newBaby.birthDate,
        description: `Chegada tão esperada do nosso anjinho com ${newBaby.weightKg} kg e ${newBaby.heightCm} cm.`,
        photoUrl: newBaby.photoUrl,
        emoji: '👶',
      },
      {
        id: 'm-' + Date.now() + '-2',
        babyId: newBabyId,
        title: 'Primeiro Sorriso',
        ageLabel: '1º Mês',
        date: newBaby.birthDate,
        description: 'Aquele sorrisinho dormindo que derreteu o coração de todos.',
        photoUrl: newBaby.photoUrl,
        emoji: '✨',
      },
    ];
    db.milestones.push(...defaultMilestones);

    // Add a couple of initial suggested gifts for convenience
    const defaultGifts = [
      {
        id: 'g-' + Date.now() + '-1',
        babyId: newBabyId,
        title: 'Pacote de Fraldas RN / P Confort',
        category: 'Higiene & Fraldas',
        estimatedPrice: 79.9,
        status: 'available' as const,
        priority: 'alta' as const,
        notes: 'Marca de preferência da mamãe',
      },
      {
        id: 'g-' + Date.now() + '-2',
        babyId: newBabyId,
        title: 'Kit Toalhas de Banho com Capuz 100% Algodão',
        category: 'Higiene & Fraldas',
        estimatedPrice: 95.0,
        status: 'available' as const,
        priority: 'alta' as const,
      },
    ];
    db.gifts.push(...defaultGifts);

    writeDb(db);

    return res.json({ baby: newBaby });
  });

  // Update a baby profile (Mother only)
  app.put('/api/mothers/me/babies/:babyId', authMiddleware, (req: AuthenticatedRequest, res) => {
    const { babyId } = req.params;
    const motherId = req.currentMother!.id;
    const db = readDb();

    const babyIndex = db.babies.findIndex((b) => b.id === babyId && b.motherId === motherId);
    if (babyIndex === -1) {
      return res.status(403).json({ error: 'Você não tem permissão para editar esta página.' });
    }

    const current = db.babies[babyIndex];
    const updated = {
      ...current,
      ...req.body,
      id: current.id, // cannot change id
      motherId: current.motherId, // cannot transfer
    };

    db.babies[babyIndex] = updated;
    writeDb(db);

    return res.json({ baby: updated });
  });

  // Gifts management (Mother only)
  app.get('/api/mothers/me/babies/:babyId/gifts', authMiddleware, (req: AuthenticatedRequest, res) => {
    const { babyId } = req.params;
    const motherId = req.currentMother!.id;
    const db = readDb();

    const baby = db.babies.find((b) => b.id === babyId && b.motherId === motherId);
    if (!baby) {
      return res.status(403).json({ error: 'Acesso negado.' });
    }

    const babyGifts = db.gifts.filter((g) => g.babyId === babyId);
    return res.json({ gifts: babyGifts });
  });

  app.post('/api/mothers/me/babies/:babyId/gifts', authMiddleware, (req: AuthenticatedRequest, res) => {
    const { babyId } = req.params;
    const motherId = req.currentMother!.id;
    const { title, category, estimatedPrice, notes, priority } = req.body;

    if (!title) {
      return res.status(400).json({ error: 'O título do presente é obrigatório.' });
    }

    const db = readDb();
    const baby = db.babies.find((b) => b.id === babyId && b.motherId === motherId);
    if (!baby) {
      return res.status(403).json({ error: 'Acesso negado.' });
    }

    const newGift = {
      id: 'g-' + Date.now() + '-' + Math.random().toString(36).substring(2, 6),
      babyId,
      title: title.trim(),
      category: category || 'Higiene & Fraldas',
      estimatedPrice: parseFloat(estimatedPrice) || undefined,
      status: 'available' as const,
      notes: notes?.trim() || undefined,
      priority: priority || 'media',
    };

    db.gifts.unshift(newGift);
    writeDb(db);

    return res.json({ gift: newGift });
  });

  app.put('/api/mothers/me/babies/:babyId/gifts/:giftId', authMiddleware, (req: AuthenticatedRequest, res) => {
    const { babyId, giftId } = req.params;
    const motherId = req.currentMother!.id;
    const db = readDb();

    const baby = db.babies.find((b) => b.id === babyId && b.motherId === motherId);
    if (!baby) {
      return res.status(403).json({ error: 'Acesso negado.' });
    }

    const giftIndex = db.gifts.findIndex((g) => g.id === giftId && g.babyId === babyId);
    if (giftIndex === -1) {
      return res.status(404).json({ error: 'Presente não encontrado.' });
    }

    const currentGift = db.gifts[giftIndex];
    const updated = {
      ...currentGift,
      ...req.body,
      id: currentGift.id,
      babyId: currentGift.babyId,
    };

    db.gifts[giftIndex] = updated;
    writeDb(db);

    return res.json({ gift: updated });
  });

  app.delete('/api/mothers/me/babies/:babyId/gifts/:giftId', authMiddleware, (req: AuthenticatedRequest, res) => {
    const { babyId, giftId } = req.params;
    const motherId = req.currentMother!.id;
    const db = readDb();

    const baby = db.babies.find((b) => b.id === babyId && b.motherId === motherId);
    if (!baby) {
      return res.status(403).json({ error: 'Acesso negado.' });
    }

    db.gifts = db.gifts.filter((g) => !(g.id === giftId && g.babyId === babyId));
    writeDb(db);

    return res.json({ success: true });
  });

  // Delete/moderate message (Mother only)
  app.delete('/api/mothers/me/babies/:babyId/messages/:messageId', authMiddleware, (req: AuthenticatedRequest, res) => {
    const { babyId, messageId } = req.params;
    const motherId = req.currentMother!.id;
    const db = readDb();

    const baby = db.babies.find((b) => b.id === babyId && b.motherId === motherId);
    if (!baby) {
      return res.status(403).json({ error: 'Acesso negado.' });
    }

    db.messages = db.messages.filter((m) => !(m.id === messageId && m.babyId === babyId));
    writeDb(db);

    return res.json({ success: true });
  });

  // =================================================================
  // PUBLIC ROUTES (ACCESS ONLY VIA DIRECT LINK / BABY ID)
  // Strict Privacy: There is NO endpoint listing all babies publicly!
  // Anyone with the baby's specific ID/link can view and interact.
  // =================================================================

  // Get specific baby by ID
  app.get('/api/public/baby/:id', (req, res) => {
    const { id } = req.params;
    const db = readDb();

    const baby = db.babies.find((b) => b.id === id);
    if (!baby) {
      return res.status(404).json({
        error: 'Página do bebê não encontrada. Verifique se o código ou link está correto.',
      });
    }

    // Return baby info without sensitive data
    return res.json({
      baby: {
        id: baby.id,
        motherId: baby.motherId,
        name: baby.name,
        nickname: baby.nickname,
        birthDate: baby.birthDate,
        birthTime: baby.birthTime,
        gender: baby.gender,
        weightKg: baby.weightKg,
        heightCm: baby.heightCm,
        bloodType: baby.bloodType,
        zodiacSign: baby.zodiacSign,
        hospitalCity: baby.hospitalCity,
        birthStory: baby.birthStory,
        traits: baby.traits,
        photoUrl: baby.photoUrl,
        ultrasoundPhotoUrl: baby.ultrasoundPhotoUrl,
        pixKey: baby.pixKey,
        pixKeyType: baby.pixKeyType,
        pixHolderName: baby.pixHolderName,
        themeColor: baby.themeColor,
        createdAt: baby.createdAt,
      },
    });
  });

  // Get gifts for this baby
  app.get('/api/public/baby/:id/gifts', (req, res) => {
    const { id } = req.params;
    const db = readDb();

    const babyExists = db.babies.some((b) => b.id === id);
    if (!babyExists) {
      return res.status(404).json({ error: 'Bebê não encontrado.' });
    }

    const babyGifts = db.gifts.filter((g) => g.babyId === id);
    return res.json({ gifts: babyGifts });
  });

  // Guest reserves a gift (Only Name & Phone required, frictionless!)
  app.post('/api/public/baby/:id/gifts/:giftId/reserve', (req, res) => {
    const { id, giftId } = req.params;
    const { name, phone, note } = req.body;

    if (!name || !phone) {
      return res.status(400).json({ error: 'Nome e telefone são obrigatórios para reservar.' });
    }

    const db = readDb();
    const gift = db.gifts.find((g) => g.id === giftId && g.babyId === id);

    if (!gift) {
      return res.status(404).json({ error: 'Presente não encontrado.' });
    }

    if (gift.status === 'reserved') {
      return res.status(409).json({ error: 'Este presente já foi reservado por outro convidado.' });
    }

    gift.status = 'reserved';
    gift.reservedBy = {
      name: name.trim(),
      phone: phone.trim(),
      note: note?.trim(),
      reservedAt: new Date().toISOString(),
    };

    writeDb(db);

    return res.json({ success: true, gift });
  });

  // Get milestones for this baby
  app.get('/api/public/baby/:id/milestones', (req, res) => {
    const { id } = req.params;
    const db = readDb();

    const milestones = db.milestones.filter((m) => m.babyId === id);
    return res.json({ milestones });
  });

  // Get messages for this baby
  app.get('/api/public/baby/:id/messages', (req, res) => {
    const { id } = req.params;
    const db = readDb();

    const messages = db.messages.filter((m) => m.babyId === id);
    // Sort descending by date
    messages.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return res.json({ messages });
  });

  // Guest leaves a message
  app.post('/api/public/baby/:id/messages', (req, res) => {
    const { id } = req.params;
    const { authorName, relationship, message } = req.body;

    if (!authorName || !message) {
      return res.status(400).json({ error: 'Nome e mensagem são obrigatórios.' });
    }

    const db = readDb();
    const babyExists = db.babies.some((b) => b.id === id);
    if (!babyExists) {
      return res.status(404).json({ error: 'Bebê não encontrado.' });
    }

    const newMessage = {
      id: 'msg-' + Date.now() + '-' + Math.random().toString(36).substring(2, 6),
      babyId: id,
      authorName: authorName.trim(),
      relationship: (relationship || 'Amigo da Família').trim(),
      message: message.trim(),
      createdAt: new Date().toISOString(),
      likes: 0,
    };

    db.messages.unshift(newMessage);
    writeDb(db);

    return res.json({ message: newMessage });
  });

  // Like a message
  app.post('/api/public/baby/:id/messages/:messageId/like', (req, res) => {
    const { id, messageId } = req.params;
    const db = readDb();

    const msg = db.messages.find((m) => m.id === messageId && m.babyId === id);
    if (!msg) {
      return res.status(404).json({ error: 'Mensagem não encontrada.' });
    }

    msg.likes = (msg.likes || 0) + 1;
    writeDb(db);

    return res.json({ likes: msg.likes });
  });

  // ==========================================
  // VITE MIDDLEWARE OR STATIC PRODUCTION
  // ==========================================
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`MeuBebê Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
