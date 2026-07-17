// Action labels whose former catalogue keys included platform-dependent glyphs.
// SVG icons now render separately, so the translated text stays glyph-free.
export const ACTION_CATALOG: string[][] = [
  ["GUI color", "界面颜色", "GUI 색상", "GUIカラー", "لون الواجهة", "Colore GUI"],
  ["Text color", "文字颜色", "텍스트 색상", "テキストカラー", "لون النص", "Colore testo"],
  ["Choose GUI color", "选择界面颜色", "GUI 색상 선택", "GUIカラーを選択", "اختر لون الواجهة", "Scegli il colore GUI"],
  ["Choose text color", "选择文字颜色", "텍스트 색상 선택", "テキストカラーを選択", "اختر لون النص", "Scegli il colore del testo"],
  ["GUI color palette", "界面调色板", "GUI 색상 팔레트", "GUIカラーパレット", "لوحة ألوان الواجهة", "Tavolozza colori GUI"],
  ["Text color palette", "文字调色板", "텍스트 색상 팔레트", "テキストカラーパレット", "لوحة ألوان النص", "Tavolozza colori testo"],
  ["Feed", "订阅", "피드", "フィード", "تغذية", "Feed"],
  ["Re-feed", "重新订阅", "재피드", "再フィード", "إعادة التغذية", "Re-feed"],
  ["Reopen", "重新打开", "다시 열기", "再度開く", "إعادة فتح", "Riapri"],
  ["Send report", "发送报告", "보고서 전송", "レポートを送信", "إرسال التقرير", "Invia rapporto"],
  ["Active", "进行中", "진행 중", "進行中", "قيد التنفيذ", "Attivi"],
  ["All steps done — reopen one from the Archive tab, or add a new step above.", "所有步骤完成——从存档标签页重新打开一个，或在上方添加一个新步骤。", "모든 단계가 완료되었습니다 — 보관 탭에서 하나를 다시 열거나 위에 새 단계를 추가하세요.", "すべてのステップが完了しました — アーカイブタブから1つを再開するか、上に新しいステップを追加してください。", "تمت جميع الخطوات — أعد فتح واحدة من تبويب الأرشيف، أو أضف خطوة جديدة أعلاه.", "Tutti i passaggi completati — riaprine uno dalla scheda Archivio, oppure aggiungi un nuovo passaggio sopra."],
  ["No archived steps yet — steps marked done move here.", "尚无已存档的步骤——标记为完成的步骤会移到这里。", "아직 보관된 단계가 없습니다 — 완료로 표시된 단계가 여기로 이동합니다.", "アーカイブされたステップはまだありません — 完了にしたステップはここに移動します。", "لا توجد خطوات مؤرشفة بعد — تنتقل الخطوات المكتملة إلى هنا.", "Nessun passaggio archiviato — i passaggi contrassegnati come completati vengono spostati qui."],
  ["No steps yet — add one above, or digest your notes below.", "尚无步骤 — 在上方添加一个，或在下方消化您的笔记。", "아직 단계가 없습니다 — 위에서 추가하거나, 아래에서 메모를 요약하세요.", "まだステップはありません — 上に追加するか、下のメモを処理してください。", "لا توجد خطوات بعد — أضف واحدة أعلاه، أو عالج ملاحظاتك أدناه.", "Nessun passaggio ancora — aggiungine uno sopra, o elabora le tue note qui sotto."],
  ["Chat text size", "聊天文字大小", "채팅 글자 크기", "チャット文字サイズ", "حجم نص الدردشة", "Dimensione testo chat"],
  ["Increase chat text size", "增大聊天文字", "채팅 글자 크게", "チャット文字を大きく", "تكبير نص الدردشة", "Aumenta dimensione testo chat"],
  ["Decrease chat text size", "减小聊天文字", "채팅 글자 작게", "チャット文字を小さく", "تصغير نص الدردشة", "Riduci dimensione testo chat"],
  ["Fix with agent", "让智能体修复", "에이전트로 수정", "エージェントで修正", "إصلاح بواسطة الوكيل", "Correggi con l'agente"],
  ["Send these failures to the coder agent to diagnose and fix", "将这些失败发送给编码智能体进行诊断和修复", "이 실패를 코더 에이전트에게 보내 진단하고 수정하게 합니다", "これらの失敗をコーダーエージェントに送信して診断・修正します", "أرسل هذه الإخفاقات إلى وكيل البرمجة لتشخيصها وإصلاحها", "Invia questi errori all'agente coder per diagnosticarli e correggerli"],
  ["Sent to the coder agent — watch the chat for the fix.", "已发送给编码智能体——请在聊天中查看修复进展。", "코더 에이전트에게 전송되었습니다 — 채팅에서 수정 내용을 확인하세요.", "コーダーエージェントに送信しました — チャットで修正を確認してください。", "تم الإرسال إلى وكيل البرمجة — تابع الدردشة لمشاهدة الإصلاح.", "Inviato all'agente coder — segui la chat per la correzione."],
];
