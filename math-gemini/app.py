import streamlit as st
from google import genai
from google.genai import types

# --------------------------------------------------
# 1. システムプロンプトの設定（Gemの事前指示に相当）
# --------------------------------------------------
SYSTEM_INSTRUCTION = """
## 質問者の状況
私は、高校数学の教科書内容を全て学習し終えた、難関大学への合格を目指す理系の高校3年生です。

## 解答者の条件
あなたは、数学が苦手な私を、大学合格へ導く数学の優秀な教育者です。

## 行動
問題が入力されたら、次の手順通りに教えてください。

## 手順
1. まず、入力された問題を読み取ってください。問題が複数ある場合は、1問づつ分けた上で、以下手順を問題ごとに繰り返してください。
2. 入力された問題を解くために必要な、教科書レベルの基礎知識を説明してください。
3. 入力された問題を解く上での考え方を教えてください。
4. 入力された問題の模範解答を、ステップに分けて作成してください。
5. なぜその解法を選択したのか、その解法を選択する必然性を教えてください。その際、間違って選択してしまいがちな別の解法があれば、それを全て挙げて、それらはなぜ使用できないのか、どのような条件ならその解法を使用するかも解説してください。

## 注意事項
- 数式を出力する際は、必ずLaTeX形式（$ ... $ または $$ ... $$）を使用してください。
- 三角関数は、sin, cos, tanのみを使用してください。sec, csc, cotなどは使用しないでください。
- 計算は丁寧にしてください。計算ミスは許されません。
- 記述解答を作る際、減点のない、完璧な答案を書いてください。
- 「解法の必然性」は、別の問題を解くときに再現性があるように、丁寧に詳しく書いてください。
"""

# --------------------------------------------------
# 2. ページ基本設定
# --------------------------------------------------
st.set_page_config(
    page_title="高校数学・大学受験AIチューター",
    page_icon="📐",
    layout="wide"
)

st.title("📐 高校数学・大学受験AIチューター")
st.caption("難関大目指す理系高3生のための解法・解説ジェネレーター (Powered by Gemini 1.5 Pro)")

# --------------------------------------------------
# 3. Gemini API クライアントの初期化
# --------------------------------------------------
if "GEMINI_API_KEY" in st.secrets:
    api_key = st.secrets["GEMINI_API_KEY"]
else:
    st.error("APIキーが設定されていません。Streamlit Community CloudのSecretsに `GEMINI_API_KEY` を設定してください。")
    st.stop()

client = genai.Client(api_key=api_key)

# --------------------------------------------------
# 4. セッション状態の初期化
# --------------------------------------------------
# チャットインスタンス（履歴保持用）
if "chat" not in st.session_state:
    st.session_state.chat = None

# UI描画用のメッセージ履歴
if "messages" not in st.session_state:
    st.session_state.messages = []

# 現在解説中の「メイン問題」
if "current_problem" not in st.session_state:
    st.session_state.current_problem = None

# --------------------------------------------------
# 5. サイドバー：新しく問題をセット（リセット機能）
# --------------------------------------------------
with st.sidebar:
    st.header("📝 新しい問題を解く")
    st.write("別の問題を解き直したい場合は、ここから入力してください。これまでの質問チャットはリセットされます。")
    
    with st.form(key="new_problem_form", clear_on_submit=True):
        new_problem_input = st.text_area(
            "数学の問題を入力してください",
            height=200,
            placeholder="例: $x^2 + y^2 = 4$ と $y = x + k$ が異なる2点で交わるような定数 $k$ の値の範囲を求めよ。"
        )
        submit_button = st.form_submit_button("この問題を解説させる")

    if submit_button and new_problem_input.strip():
        # 新しい問題が送信されたら、チャットとセッションを初期化
        st.session_state.current_problem = new_problem_input.strip()
        st.session_state.messages = []
        
        # Gemini Clientのチャットセッションを作成（システムプロンプト付き）
        st.session_state.chat = client.chats.create(
            model="gemini-1.5-pro",
            config=types.GenerateContentConfig(
                system_instruction=SYSTEM_INSTRUCTION,
                temperature=0.2, # 数学のため創造性を低めに設定
            )
        )
        
        # 最初のプロンプトを構築して自動送信
        initial_prompt = f"以下の問題を指示通りの手順で解説してください。\n\n【問題】\n{st.session_state.current_problem}"
        
        # ユーザー側入力メッセージとして記録
        st.session_state.messages.append({"role": "user", "content": st.session_state.current_problem})
        
        # Geminiに送信して回答を取得
        with st.spinner("AIが解答と解説を生成中です...（1分程度かかる場合があります）"):
            response = st.session_state.chat.send_message(initial_prompt)
            st.session_state.messages.append({"role": "assistant", "content": response.text})
            
        st.rerun()

# --------------------------------------------------
# 6. メイン画面の表示とチャット機能
# --------------------------------------------------
if not st.session_state.current_problem:
    st.info("👈 左側のサイドバーから数学の問題を入力してください。")
else:
    # 現在の問題を強調表示
    st.subheader("📌 解答中の問題")
    st.info(st.session_state.current_problem)
    st.divider()

    # これまでのやり取り（解説 + 追加の質疑応答）を表示
    for message in st.session_state.messages:
        with st.chat_message(message["role"]):
            st.markdown(message["content"])

    # この問題に対する追加質問チャットUI
    if prompt := st.chat_input("この解説について質問や気になる点があれば入力してください..."):
        # 画面にユーザーメッセージを表示＆記録
        st.session_state.messages.append({"role": "user", "content": prompt})
        with st.chat_message("user"):
            st.markdown(prompt)

        # Geminiから回答を取得
        with st.chat_message("assistant"):
            with st.spinner("思考中..."):
                response = st.session_state.chat.send_message(prompt)
                st.markdown(response.text)
                st.session_state.messages.append({"role": "assistant", "content": response.text})
