document.getElementById("btnSaibaMais").addEventListener("click", function() {
  document.getElementById("sobre").scrollIntoView({ behavior: "smooth" });
});

document.getElementById("formContato").addEventListener("submit", function(e) {
  e.preventDefault();
  alert("Obrigada por entrar em contato, sua mensagem foi enviada com sucesso! 💌");
  this.reset();
});

