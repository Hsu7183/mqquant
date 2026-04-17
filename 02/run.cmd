@echo off
setlocal
if not defined MQQUANT_SOURCE_ROOT set MQQUANT_SOURCE_ROOT=C:\xs_optimizer_v1
py -m streamlit run app.py
