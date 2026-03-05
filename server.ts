import express from "express";
import { createServer as createViteServer } from "vite";
import Database from "better-sqlite3";
import path from "path";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import cors from "cors";

// Configurações iniciais
const app = express();
const PORT = 3000;
const JWT_SECRET = "restaurante-secreto-123"; // Em produção, use variáveis de ambiente

// Inicialização do Banco de Dados (SQLite)
// O SQLite é um arquivo local, não precisa de servidor MySQL externo.
const db = new Database("restaurante.db");

// Criar tabelas se não existirem
db.exec(`
  CREATE TABLE IF NOT EXISTS usuarios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    password TEXT
  );

  CREATE TABLE IF NOT EXISTS produtos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    price REAL,
    category TEXT,
    active INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS pedidos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_number TEXT UNIQUE,
    status TEXT DEFAULT 'Criado',
    total_amount REAL,
    observation TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS itens_pedido (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER,
    product_id INTEGER,
    quantity INTEGER,
    type TEXT,
    price_at_time REAL,
    FOREIGN KEY(order_id) REFERENCES pedidos(id),
    FOREIGN KEY(product_id) REFERENCES produtos(id)
  );

  CREATE TABLE IF NOT EXISTS pagamentos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER,
    method TEXT,
    amount_paid REAL,
    change_given REAL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(order_id) REFERENCES pedidos(id)
  );
`);

// Criar usuário administrador padrão se não existir
const adminExists = db.prepare("SELECT * FROM usuarios WHERE username = ?").get("admin");
if (!adminExists) {
  const hashedPassword = bcrypt.hashSync("admin123", 10);
  db.prepare("INSERT INTO usuarios (username, password) VALUES (?, ?)").run("admin", hashedPassword);
}

// Middleware
app.use(cors());
app.use(express.json());

// --- ROTAS DE AUTENTICAÇÃO ---

// Rota de Login
app.post("/api/login", (req, res) => {
  const { username, password } = req.body;
  const user: any = db.prepare("SELECT * FROM usuarios WHERE username = ?").get(username);

  if (user && bcrypt.compareSync(password, user.password)) {
    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: "1d" });
    res.json({ success: true, token, user: { id: user.id, username: user.username } });
  } else {
    res.status(401).json({ success: false, message: "Usuário ou senha incorretos" });
  }
});

// Middleware para proteger rotas
const authenticateToken = (req: any, res: any, next: any) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) return res.sendStatus(401);

  jwt.verify(token, JWT_SECRET, (err: any, user: any) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
};

// --- ROTAS DE PRODUTOS ---

// Listar produtos
app.get("/api/products", (req, res) => {
  const products = db.prepare("SELECT * FROM produtos").all();
  res.json(products);
});

// Cadastrar produto
app.post("/api/products", authenticateToken, (req, res) => {
  const { name, price, category, active } = req.body;
  const result = db.prepare("INSERT INTO produtos (name, price, category, active) VALUES (?, ?, ?, ?)")
    .run(name, price, category, active ? 1 : 0);
  res.json({ id: result.lastInsertRowid });
});

// Atualizar produto
app.put("/api/products/:id", authenticateToken, (req, res) => {
  const { name, price, category, active } = req.body;
  db.prepare("UPDATE produtos SET name = ?, price = ?, category = ?, active = ? WHERE id = ?")
    .run(name, price, category, active ? 1 : 0, req.params.id);
  res.json({ success: true });
});

// --- ROTAS DE PEDIDOS ---

// Criar novo pedido
app.post("/api/orders", authenticateToken, (req, res) => {
  const { items, payment, observation, total_amount } = req.body;

  // Gerar número do pedido sequencial (ex: 001, 002...)
  const lastOrder: any = db.prepare("SELECT id FROM pedidos ORDER BY id DESC LIMIT 1").get();
  const nextId = (lastOrder?.id || 0) + 1;
  const orderNumber = nextId.toString().padStart(3, '0');

  // Usar transação para garantir integridade
  const transaction = db.transaction(() => {
    // 1. Inserir pedido
    const orderResult = db.prepare(
      "INSERT INTO pedidos (order_number, total_amount, observation) VALUES (?, ?, ?)"
    ).run(orderNumber, total_amount, observation);
    
    const orderId = orderResult.lastInsertRowid;

    // 2. Inserir itens do pedido
    const insertItem = db.prepare(
      "INSERT INTO itens_pedido (order_id, product_id, quantity, type, price_at_time) VALUES (?, ?, ?, ?, ?)"
    );
    for (const item of items) {
      insertItem.run(orderId, item.product_id, item.quantity, item.type, item.price_at_time);
    }

    // 3. Inserir pagamento
    db.prepare(
      "INSERT INTO pagamentos (order_id, method, amount_paid, change_given) VALUES (?, ?, ?, ?)"
    ).run(orderId, payment.method, payment.amount_paid, payment.change_given);

    return { orderId, orderNumber };
  });

  try {
    const result = transaction();
    res.json({ success: true, ...result });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: "Erro ao processar pedido" });
  }
});

// Listar pedidos recentes
app.get("/api/orders", authenticateToken, (req, res) => {
  const orders = db.prepare("SELECT * FROM pedidos ORDER BY id DESC LIMIT 50").all();
  res.json(orders);
});

// Atualizar status do pedido
app.patch("/api/orders/:id/status", authenticateToken, (req, res) => {
  const { status } = req.body;
  db.prepare("UPDATE pedidos SET status = ? WHERE id = ?").run(status, req.params.id);
  res.json({ success: true });
});

// --- ROTAS DE DASHBOARD E RELATÓRIOS ---

app.get("/api/dashboard/stats", authenticateToken, (req, res) => {
  // Total hoje
  const today: any = db.prepare("SELECT SUM(total_amount) as total FROM pedidos WHERE date(created_at) = date('now')").get();
  
  // Total semana
  const week: any = db.prepare("SELECT SUM(total_amount) as total FROM pedidos WHERE date(created_at) >= date('now', '-7 days')").get();
  
  // Total mês
  const month: any = db.prepare("SELECT SUM(total_amount) as total FROM pedidos WHERE date(created_at) >= date('now', 'start of month')").get();

  // Vendas por produto
  const productSales = db.prepare(`
    SELECT p.name, SUM(i.quantity) as quantity
    FROM itens_pedido i
    JOIN produtos p ON i.product_id = p.id
    GROUP BY p.id
    ORDER BY quantity DESC
  `).all();

  res.json({
    today: today?.total || 0,
    week: week?.total || 0,
    month: month?.total || 0,
    productSales
  });
});

app.get("/api/dashboard/cash-report", authenticateToken, (req, res) => {
  const report = db.prepare(`
    SELECT 
      SUM(CASE WHEN method = 'Dinheiro' THEN amount_paid - change_given ELSE 0 END) as cash,
      SUM(CASE WHEN method = 'PIX' THEN amount_paid ELSE 0 END) as pix,
      SUM(CASE WHEN method = 'Débito' THEN amount_paid ELSE 0 END) as debit,
      SUM(CASE WHEN method = 'Crédito' THEN amount_paid ELSE 0 END) as credit,
      SUM(amount_paid - change_given) as total
    FROM pagamentos
    WHERE date(created_at) = date('now')
  `).get();

  res.json(report || { cash: 0, pix: 0, debit: 0, credit: 0, total: 0 });
});

// --- CONFIGURAÇÃO DO VITE ---

async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(__dirname, "dist")));
    app.get("*", (req, res) => {
      res.sendFile(path.join(__dirname, "dist", "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Servidor rodando em http://localhost:${PORT}`);
  });
}

startServer();
